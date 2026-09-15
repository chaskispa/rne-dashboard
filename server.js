import dgram from 'node:dgram';
import { promises as dns } from 'node:dns';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = path.resolve(process.env.RNE_DATA_DIR || path.join(__dirname, 'data'));
const configPath = path.join(dataDir, 'config.json');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4173);
const POLL_INTERVAL_MS = 30_000;
const LAN_SCAN_INTERVAL_MS = 60_000;
const MAX_EVENTS = 400;
const MAX_BODY_BYTES = 32 * 1024;
const execFileAsync = promisify(execFile);
const networkHelper = process.env.RNE_NETWORK_HELPER || '/usr/local/lib/rne-dashboard/network-helper';
const adminTokenPath = process.env.RNE_ADMIN_TOKEN_FILE || path.join(dataDir, 'admin-token');
const PRODUCTION_API_BASE_URL = 'https://registronacionaldeespera.cl';
const API_BASE_URL = process.env.NODE_ENV === 'test' && process.env.RNE_TEST_API_BASE_URL
  ? process.env.RNE_TEST_API_BASE_URL
  : PRODUCTION_API_BASE_URL;
const CATEGORIES = ['hospitalario', 'tramites', 'transporte', 'vivienda', 'otro'];
const SOURCE_TYPES = ['total', ...CATEGORIES, 'latest_wait', 'latest_testimony', 'custom'];
const DISPLAY_UNITS = ['auto', 'minutes', 'hours', 'days', 'months', 'years'];
const DISPLAY_MODES = ['both', 'time', 'label'];

const defaultConfig = {
  panels: []
};

let config = structuredClone(defaultConfig);
let results = null;
let health = null;
let lastPollAt = null;
let nextPollAt = null;
let polling = false;
let timer = null;
let lanTimer = null;
let events = [];
let adminToken = '';
let lanScan = { available: null, scanning: false, lastScanAt: null, devices: [], error: null };
const panelRuntime = new Map();
const sseClients = new Set();

function json(reply, status, payload) {
  const body = JSON.stringify(payload);
  reply.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  reply.end(body);
}

function isIpv4OrHostname(value) {
  if (!/^(?=.{1,253}$)(localhost|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i.test(value)) return false;
  if (/^\d+(?:\.\d+){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return true;
}

function normalizeRgbColor(value, fallback) {
  const match = String(value || '').trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? match[1].toUpperCase() : fallback;
}

function validatePanel(candidate, existing = {}) {
  const panel = { ...existing, ...candidate };
  panel.id = existing.id || randomUUID();
  panel.name = String(panel.name || '').trim().slice(0, 60);
  panel.host = String(panel.host || '').trim();
  panel.port = Number(panel.port ?? 5000);
  panel.source = String(panel.source || 'total');
  panel.template = String(panel.template || '').trim().slice(0, 240);
  panel.unit = DISPLAY_UNITS.includes(panel.unit) ? panel.unit : 'auto';
  panel.displayMode = DISPLAY_MODES.includes(panel.displayMode)
    ? panel.displayMode
    : panel.showLabel === false ? 'time' : 'both';
  delete panel.showLabel;
  panel.colorsEnabled = panel.colorsEnabled === true;
  panel.labelColor = normalizeRgbColor(panel.labelColor, '00FF00');
  panel.timeColor = normalizeRgbColor(panel.timeColor, 'FF0000');
  panel.enabled = panel.enabled !== false;
  if (!panel.name) throw new Error('El panel necesita un nombre.');
  if (!isIpv4OrHostname(panel.host)) throw new Error('La dirección del panel no es válida.');
  if (!Number.isInteger(panel.port) || panel.port < 1 || panel.port > 65535) throw new Error('El puerto UDP no es válido.');
  if (!SOURCE_TYPES.includes(panel.source)) throw new Error('La fuente seleccionada no es válida.');
  if (panel.source === 'custom' && !panel.template) throw new Error('La plantilla personalizada está vacía.');
  return panel;
}

async function loadConfig() {
  await mkdir(dataDir, { recursive: true });
  try {
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    config.panels = Array.isArray(saved.panels)
      ? saved.panels.map((panel) => validatePanel(panel, { id: panel.id || randomUUID() }))
      : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load config:', error.message);
  }
}

async function loadAdminToken() {
  try {
    adminToken = (await readFile(adminTokenPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load admin token:', error.message);
  }
}

function hasAdminAccess(request) {
  if (!adminToken) return false;
  const supplied = String(request.headers['x-rne-admin-token'] || '');
  const expectedBuffer = Buffer.from(adminToken);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

async function saveConfig() {
  const temporaryPath = `${configPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, configPath);
}

function addEvent(event) {
  events.unshift({ id: randomUUID(), at: new Date().toISOString(), ...event });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  broadcast();
}

function publicState() {
  const activePanels = config.panels.filter((panel) => panel.enabled).length;
  const publicEvents = events.map(({ id, at, kind, method, target, status, ok, panelId, panelName }) => ({
    id, at, kind, method, target, status, ok, panelId, panelName
  }));
  const publicResults = results ? {
    version: results.version,
    actualizado_en: results.actualizado_en,
    unidad_tiempo: results.unidad_tiempo,
    tiempo_total: results.tiempo_total,
    tiempo_por_area: results.tiempo_por_area,
    entrada_count: Array.isArray(results.entradas) ? results.entradas.length : 0,
    entradas: Array.isArray(results.entradas) && results.entradas.length ? [results.entradas.at(-1)] : []
  } : null;
  return {
    config,
    apiBaseUrl: API_BASE_URL,
    pollIntervalSeconds: POLL_INTERVAL_MS / 1000,
    lastPollAt,
    nextPollAt,
    polling,
    health,
    results: publicResults,
    lan: lanScan,
    events: publicEvents,
    activePanels,
    panelRuntime: Object.fromEntries(panelRuntime)
  };
}

function broadcast() {
  if (!sseClients.size) return;
  const message = `event: update\ndata: ${Date.now()}\n\n`;
  for (const client of sseClients) client.write(message);
}

async function fetchLogged(endpoint, type) {
  const url = `${API_BASE_URL}${endpoint}`;
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'rne-panel-dashboard/1.0' },
      signal: AbortSignal.timeout(10_000)
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const durationMs = Math.round(performance.now() - started);
    addEvent({
      kind: 'api', method: 'GET', target: endpoint, status: response.status,
      ok: response.ok, durationMs, bytes: buffer.length
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = JSON.parse(buffer.toString('utf8'));
    return { parsed, type };
  } catch (error) {
    if (!events[0] || events[0].target !== endpoint || events[0].ok !== false) {
      addEvent({
        kind: 'api', method: 'GET', target: endpoint, status: null,
        ok: false, durationMs: Math.round(performance.now() - started), error: error.message
      });
    }
    throw error;
  }
}

function contextFromResults(data) {
  const latest = Array.isArray(data?.entradas) ? data.entradas.at(-1) : null;
  const area = data?.tiempo_por_area || {};
  return {
    total_minutes: data?.tiempo_total ?? 0,
    total_hours: String(Math.round((data?.tiempo_total ?? 0) / 60)),
    hospitalario: area.hospitalario ?? 0,
    tramites: area.tramites ?? 0,
    transporte: area.transporte ?? 0,
    vivienda: area.vivienda ?? 0,
    otro: area.otro ?? 0,
    latest_minutes: latest?.tiempo_minutos ?? 0,
    latest_area: latest?.area ?? 'sin datos',
    latest_comuna: latest?.comuna ?? 'sin datos',
    latest_region: latest?.region ?? 'sin datos',
    latest_testimony: latest?.testimonio || 'Sin testimonio público'
  };
}

function durationUnit(minutes, requestedUnit = 'auto') {
  if (requestedUnit !== 'auto') return requestedUnit;
  const absolute = Math.abs(minutes);
  if (absolute < 60) return 'minutes';
  if (absolute < 60 * 24) return 'hours';
  if (absolute < 60 * 24 * 30) return 'days';
  if (absolute < 60 * 24 * 365) return 'months';
  return 'years';
}

function formatDuration(minutes, requestedUnit = 'auto') {
  const unit = durationUnit(minutes, requestedUnit);
  const divisors = {
    minutes: 1,
    hours: 60,
    days: 60 * 24,
    months: 60 * 24 * 30,
    years: 60 * 24 * 365
  };
  const rawValue = minutes / divisors[unit];
  const value = Math.round(rawValue);
  const labels = {
    minutes: 'MIN',
    hours: 'H',
    days: Math.abs(value) === 1 ? 'DÍA' : 'DÍAS',
    months: Math.abs(value) === 1 ? 'MES' : 'MESES',
    years: Math.abs(value) === 1 ? 'AÑO' : 'AÑOS'
  };
  return {
    value: String(value),
    unit: labels[unit]
  };
}

function timedPanelValue(panel, context) {
  const values = {
    total: context.total_minutes,
    hospitalario: context.hospitalario,
    tramites: context.tramites,
    transporte: context.transporte,
    vivienda: context.vivienda,
    otro: context.otro,
    latest_wait: context.latest_minutes
  };
  return values[panel.source];
}

function timedPanelLabel(panel, context) {
  const labels = {
    total: 'TOTAL',
    hospitalario: 'HOSPITALARIO',
    tramites: 'TRÁMITES',
    transporte: 'TRANSPORTE',
    vivienda: 'VIVIENDA',
    otro: 'OTRO',
    latest_wait: context.latest_comuna
  };
  return labels[panel.source];
}

function coloredText(color, value) {
  return `[${color}]${value}`;
}

function clipUdpText(value, maxVisibleCharacters = 80) {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  const tokens = normalized.match(/\[[0-9a-f]{6}\]|./giu) || [];
  let visibleCharacters = 0;
  let clipped = '';
  for (const token of tokens) {
    if (/^\[[0-9a-f]{6}\]$/iu.test(token)) {
      clipped += token;
    } else if (visibleCharacters < maxVisibleCharacters) {
      clipped += token;
      visibleCharacters += 1;
    } else {
      break;
    }
  }
  return clipped || 'SIN DATOS';
}

function renderPanelMessage(panel, data) {
  const context = contextFromResults(data);
  const minutes = timedPanelValue(panel, context);
  let rendered;
  if (minutes !== undefined) {
    const label = timedPanelLabel(panel, context);
    const labelText = panel.colorsEnabled ? coloredText(panel.labelColor, label) : label;
    if (panel.displayMode === 'label') {
      rendered = labelText;
    } else {
      const duration = formatDuration(minutes, panel.unit);
      const time = `${duration.value} ${duration.unit}`;
      const timeText = panel.colorsEnabled ? coloredText(panel.timeColor, time) : time;
      rendered = panel.displayMode === 'time' ? timeText : `${labelText} ${timeText}`;
    }
  } else if (panel.source === 'latest_testimony') {
    rendered = context.latest_testimony;
  } else {
    const template = panel.template || '{total_minutes} MIN';
    rendered = template.replace(/\{([a-z_]+)\}/g, (match, key) => (
      Object.hasOwn(context, key) ? String(context[key]) : match
    ));
  }
  return clipUdpText(rendered);
}

function sendUdp(panel, message, reason = 'sync') {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const payload = Buffer.from(message, 'utf8');
    const started = performance.now();
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      const runtime = {
        at: new Date().toISOString(),
        ok: !error,
        message,
        error: error?.message || null
      };
      panelRuntime.set(panel.id, runtime);
      addEvent({
        kind: 'udp', method: 'UDP', panelId: panel.id, panelName: panel.name,
        target: `${panel.host}:${panel.port}`, ok: !error, status: null,
        durationMs: Math.round(performance.now() - started), bytes: payload.length,
        message, reason, error: error?.message
      });
      resolve(!error);
    };
    const timeout = setTimeout(() => finish(new Error('Tiempo de envío agotado')), 3_000);
    socket.send(payload, panel.port, panel.host, finish);
  });
}

async function sendAllPanels(data) {
  const enabled = config.panels.filter((panel) => panel.enabled);
  await Promise.all(enabled.map((panel) => sendUdp(panel, renderPanelMessage(panel, data))));
}

async function poll() {
  if (polling) return;
  polling = true;
  nextPollAt = null;
  broadcast();
  const [resultResponse, healthResponse] = await Promise.allSettled([
    fetchLogged('/api/results.json', 'results'),
    fetchLogged('/health', 'health')
  ]);
  if (resultResponse.status === 'fulfilled') {
    results = resultResponse.value.parsed;
    await sendAllPanels(results);
  }
  health = healthResponse.status === 'fulfilled'
    ? healthResponse.value.parsed
    : { status: 'error', database: 'unknown' };
  lastPollAt = new Date().toISOString();
  polling = false;
  nextPollAt = new Date(Date.now() + POLL_INTERVAL_MS).toISOString();
  broadcast();
  clearTimeout(timer);
  timer = setTimeout(poll, POLL_INTERVAL_MS);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('La solicitud es demasiado grande.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function splitNmcliLine(line) {
  const values = [];
  let current = '';
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === ':') {
      values.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  values.push(current);
  return values;
}

async function runNmcli(args) {
  return execFileAsync('nmcli', args, {
    timeout: 8_000,
    maxBuffer: 256 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  });
}

async function getNetworkState() {
  try {
    const { stdout } = await runNmcli(['-t', '--escape', 'yes', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']);
    const baseDevices = stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [device, type, state, connection] = splitNmcliLine(line);
      return { device, type, state, connection: connection === '--' ? '' : connection };
    }).filter(({ type }) => ['ethernet', 'wifi'].includes(type));

    const devices = await Promise.all(baseDevices.map(async (device) => {
      const field = async (args) => (await runNmcli(args)).stdout.trim();
      let hardwareAddress = '';
      try {
        hardwareAddress = await field(['-g', 'GENERAL.HWADDR', 'device', 'show', device.device]);
      } catch {}
      if (!device.connection) return { ...device, hardwareAddress, uuid: '', method: '', addresses: [], gateway: '', dns: [] };
      try {
        const uuid = await field(['-g', 'GENERAL.CON-UUID', 'device', 'show', device.device]);
        const [method, addresses, gateway, dns] = await Promise.all([
          field(['-g', 'ipv4.method', 'connection', 'show', 'uuid', uuid]),
          field(['-g', 'IP4.ADDRESS', 'device', 'show', device.device]),
          field(['-g', 'IP4.GATEWAY', 'device', 'show', device.device]),
          field(['-g', 'IP4.DNS', 'device', 'show', device.device])
        ]);
        return {
          ...device, hardwareAddress, uuid, method,
          addresses: addresses.split('\n').filter(Boolean),
          gateway: gateway.split('\n')[0] || '',
          dns: dns.split('\n').filter(Boolean)
        };
      } catch {
        return { ...device, hardwareAddress, uuid: '', method: '', addresses: [], gateway: '', dns: [] };
      }
    }));
    return { available: true, adminKeyConfigured: Boolean(adminToken), devices };
  } catch (error) {
    return {
      available: false,
      adminKeyConfigured: Boolean(adminToken),
      devices: [],
      error: error.code === 'ENOENT' ? 'NetworkManager (nmcli) no está instalado.' : error.message
    };
  }
}

function parseArpScan(output, interfaceName) {
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s*(.*)$/i);
    if (!match) return [];
    return [{
      ip: match[1], mac: match[2].toUpperCase(), vendor: match[3].trim() || 'Fabricante desconocido',
      hostname: '', interface: interfaceName, local: false
    }];
  });
}

async function mapWithLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function reverseHostname(ip) {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((resolve) => setTimeout(() => resolve([]), 1200))
    ]);
    return names[0]?.replace(/\.$/, '') || '';
  } catch {
    return '';
  }
}

async function scanLan() {
  if (lanScan.scanning) return;
  const started = performance.now();
  lanScan = { ...lanScan, scanning: true, error: null };
  broadcast();
  try {
    const network = await getNetworkState();
    if (!network.available) throw new Error(network.error || 'NetworkManager no está disponible.');
    const interfaces = network.devices.filter((device) => device.connection && ['ethernet', 'wifi'].includes(device.type));
    if (!interfaces.length) throw new Error('No hay interfaces LAN activas para escanear.');

    const scans = await Promise.allSettled(interfaces.map(async (device) => {
      const { stdout } = await runNetworkHelper(['scan', device.device]);
      return parseArpScan(stdout, device.device);
    }));
    if (!scans.some((result) => result.status === 'fulfilled')) {
      throw scans[0]?.reason || new Error('No fue posible escanear las interfaces activas.');
    }
    const discovered = scans.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    for (const networkDevice of interfaces) {
      for (const address of networkDevice.addresses || []) {
        const ip = address.split('/')[0];
        if (isIP(ip) === 4) {
          discovered.push({
            ip, mac: networkDevice.hardwareAddress?.toUpperCase() || '', vendor: 'Raspberry Pi local',
            hostname: os.hostname(), interface: networkDevice.device, local: true
          });
        }
      }
    }

    const unique = [...new Map(discovered.map((device) => [device.mac || device.ip, device])).values()]
      .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
    const devices = await mapWithLimit(unique, 12, async (device) => ({
      ...device,
      hostname: device.hostname || await reverseHostname(device.ip)
    }));
    lanScan = {
      available: true, scanning: false, lastScanAt: new Date().toISOString(), devices, error: null
    };
    addEvent({
      kind: 'system', method: 'LAN', target: 'Escaneo de red', ok: true,
      durationMs: Math.round(performance.now() - started), message: `${devices.length} dispositivos detectados`
    });
  } catch (error) {
    lanScan = {
      ...lanScan, available: false, scanning: false, lastScanAt: new Date().toISOString(), error: error.message
    };
    addEvent({
      kind: 'system', method: 'LAN', target: 'Escaneo de red', ok: false,
      durationMs: Math.round(performance.now() - started), error: error.message
    });
  } finally {
    clearTimeout(lanTimer);
    lanTimer = setTimeout(scanLan, LAN_SCAN_INTERVAL_MS);
    broadcast();
  }
}

function validateUuid(value) {
  const uuid = String(value || '');
  if (!/^[a-f0-9-]{8,64}$/i.test(uuid)) throw new Error('La conexión seleccionada no es válida.');
  return uuid;
}

function validateIpv4(value, label, allowEmpty = false) {
  const normalized = String(value || '').trim();
  if (allowEmpty && !normalized) return '';
  if (isIP(normalized) !== 4) throw new Error(`${label} no es una dirección IPv4 válida.`);
  return normalized;
}

function runNetworkHelper(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', [networkHelper, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' }
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('NetworkManager tardó demasiado en responder.'));
    }, 25_000);
    child.stdout.on('data', (chunk) => { if (stdout.length < 256 * 1024) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 256 * 1024) stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `El helper de red terminó con código ${code}.`));
    });
    child.stdin.end(input);
  });
}

async function handleApi(request, reply, url) {
  if (request.method === 'GET' && url.pathname === '/api/state') return json(reply, 200, publicState());

  if (request.method === 'GET' && url.pathname === '/api/network') {
    return json(reply, 200, await getNetworkState());
  }

  if (request.method === 'POST' && url.pathname === '/api/lan/scan') {
    if (!lanScan.scanning) void scanLan();
    return json(reply, 202, { ok: true, scanning: true });
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    reply.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    reply.write('event: connected\ndata: true\n\n');
    sseClients.add(reply);
    request.on('close', () => sseClients.delete(reply));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/panels') {
    const panel = validatePanel(await readBody(request));
    config.panels.push(panel);
    await saveConfig();
    addEvent({ kind: 'system', method: 'CONFIG', target: panel.name, ok: true, message: 'Panel creado' });
    return json(reply, 201, panel);
  }

  const panelMatch = url.pathname.match(/^\/api\/panels\/([^/]+)$/);
  if (panelMatch) {
    const index = config.panels.findIndex((panel) => panel.id === panelMatch[1]);
    if (index < 0) return json(reply, 404, { error: 'Panel no encontrado.' });
    if (request.method === 'PUT') {
      const panel = validatePanel(await readBody(request), config.panels[index]);
      config.panels[index] = panel;
      await saveConfig();
      addEvent({ kind: 'system', method: 'CONFIG', target: panel.name, ok: true, message: 'Ruta actualizada' });
      return json(reply, 200, panel);
    }
    if (request.method === 'DELETE') {
      const [removed] = config.panels.splice(index, 1);
      panelRuntime.delete(removed.id);
      await saveConfig();
      addEvent({ kind: 'system', method: 'CONFIG', target: removed.name, ok: true, message: 'Panel eliminado' });
      return json(reply, 200, { ok: true });
    }
  }

  const testMatch = url.pathname.match(/^\/api\/panels\/([^/]+)\/test$/);
  if (request.method === 'POST' && testMatch) {
    const panel = config.panels.find((item) => item.id === testMatch[1]);
    if (!panel) return json(reply, 404, { error: 'Panel no encontrado.' });
    const body = await readBody(request);
    const message = Array.from(String(body.message || 'PRUEBA RNE').trim()).slice(0, 80).join('');
    await sendUdp(panel, message || 'PRUEBA RNE', 'test');
    return json(reply, 200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/sync') {
    if (polling) return json(reply, 202, { ok: true, polling: true });
    void poll();
    return json(reply, 202, { ok: true, polling: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/network/ipv4') {
    if (!hasAdminAccess(request)) return json(reply, 401, { error: 'Clave de administración incorrecta.' });
    const body = await readBody(request);
    const uuid = validateUuid(body.uuid);
    const method = body.method === 'manual' ? 'manual' : body.method === 'auto' ? 'auto' : '';
    if (!method) throw new Error('El método IPv4 no es válido.');
    const args = ['apply', uuid, method];
    if (method === 'manual') {
      const [addressValue, prefixValue] = String(body.address || '').split('/');
      const address = validateIpv4(addressValue, 'La dirección');
      const prefix = Number(prefixValue);
      if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) throw new Error('El prefijo debe estar entre 1 y 32.');
      const gateway = validateIpv4(body.gateway, 'La puerta de enlace');
      const dns = String(body.dns || '').split(/[ ,]+/).filter(Boolean).map((item) => validateIpv4(item, 'El servidor DNS')).join(',');
      args.push(`${address}/${prefix}`, gateway, dns);
    }
    await runNetworkHelper(args);
    setTimeout(scanLan, 5_000);
    addEvent({ kind: 'system', method: 'NETWORK', target: 'Configuración IPv4', ok: true, message: method === 'auto' ? 'DHCP aplicado' : 'IP estática aplicada' });
    return json(reply, 200, { ok: true, message: 'Configuración aplicada. La conexión puede tardar unos segundos en regresar.' });
  }

  if (request.method === 'POST' && url.pathname === '/api/network/wifi') {
    if (!hasAdminAccess(request)) return json(reply, 401, { error: 'Clave de administración incorrecta.' });
    const body = await readBody(request);
    const device = String(body.device || '').trim();
    const ssid = String(body.ssid || '').trim();
    const password = String(body.password || '');
    if (!/^[a-z0-9_.:-]{1,32}$/i.test(device)) throw new Error('La interfaz Wi-Fi no es válida.');
    if (!ssid || Array.from(ssid).length > 32 || ssid.startsWith('-') || /[\r\n\0]/.test(ssid)) throw new Error('El nombre de la red Wi-Fi no es válido.');
    if (password.length < 8 || password.length > 63 || /[\r\n\0]/.test(password)) throw new Error('La contraseña Wi-Fi debe tener entre 8 y 63 caracteres.');
    await runNetworkHelper(['wifi', device, ssid], `${password}\n`);
    setTimeout(scanLan, 5_000);
    addEvent({ kind: 'system', method: 'NETWORK', target: device, ok: true, message: `Wi-Fi: ${ssid}` });
    return json(reply, 200, { ok: true, message: 'Conexión Wi-Fi iniciada. La dirección del dashboard puede cambiar.' });
  }

  return json(reply, 404, { error: 'Ruta no encontrada.' });
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.png': 'image/png'
};

function serveStatic(request, reply, url) {
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filename = path.resolve(publicDir, relative);
  if (!filename.startsWith(`${publicDir}${path.sep}`)) return json(reply, 404, { error: 'No encontrado.' });
  const stream = createReadStream(filename);
  stream.on('open', () => {
    reply.writeHead(200, {
      'content-type': contentTypes[path.extname(filename)] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    stream.pipe(reply);
  });
  stream.on('error', () => json(reply, 404, { error: 'No encontrado.' }));
}

await Promise.all([loadConfig(), loadAdminToken()]);

const server = http.createServer(async (request, reply) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(request, reply, url);
    else serveStatic(request, reply, url);
  } catch (error) {
    console.error(error);
    if (!reply.headersSent) json(reply, 400, { error: error.message || 'Solicitud inválida.' });
    else reply.end();
  }
});

server.listen(port, host, () => {
  const address = server.address();
  console.log(`RNE dashboard listening on http://${host}:${address.port}`);
  void poll();
  if (process.env.NODE_ENV !== 'test') void scanLan();
});

function shutdown() {
  clearTimeout(timer);
  clearTimeout(lanTimer);
  for (const client of sseClients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
