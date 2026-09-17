import dgram from 'node:dgram';

export const OKI_MAX_JOB_BYTES = 8192;
export const OKI_DEFAULT_HOST = '192.168.100.10';
export const OKI_DEFAULT_PORT = 5005;
export const OKI_DEFAULT_STATUS_URL = 'http://192.168.100.10:8080/healthz';

export class PrinterJobError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'PrinterJobError';
    this.statusCode = statusCode;
  }
}

export function printerConfigFromEnv(environment = process.env) {
  const host = String(environment.OKI_PRINTER_HOST || OKI_DEFAULT_HOST).trim();
  const port = Number(environment.OKI_PRINTER_PORT || OKI_DEFAULT_PORT);
  const statusUrl = String(environment.OKI_PRINTER_STATUS_URL || OKI_DEFAULT_STATUS_URL).trim();
  if (!host || /[\s/:]/.test(host)) throw new Error('OKI_PRINTER_HOST no es válido.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OKI_PRINTER_PORT no es válido.');
  const parsedStatusUrl = new URL(statusUrl);
  if (!['http:', 'https:'].includes(parsedStatusUrl.protocol)) {
    throw new Error('OKI_PRINTER_STATUS_URL debe usar HTTP o HTTPS.');
  }
  return { host, port, statusUrl };
}

export function encodePrinterJob(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new PrinterJobError('El trabajo de impresión está vacío.', 400);
  }
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > OKI_MAX_JOB_BYTES) {
    throw new PrinterJobError(`El trabajo supera el máximo de ${OKI_MAX_JOB_BYTES} bytes UTF-8.`, 413);
  }
  return payload;
}

export function sendPrinterJob(text, {
  host,
  port,
  sender = 'desconocido',
  timeoutMs = 1_500,
  socketFactory = () => dgram.createSocket('udp4'),
  logger = console
}) {
  const payload = encodePrinterJob(text);
  const destination = `${host}:${port}`;
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let timeout;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket?.close(); } catch {}
      if (error) {
        logger.error?.(`OKI print job failed bytes=${payload.length} destination=${destination} sender=${sender} error=${error.message}`);
        reject(error);
        return;
      }
      logger.info?.(`OKI print job sent bytes=${payload.length} destination=${destination} sender=${sender}`);
      resolve({ bytes: payload.length, destination });
    };

    try {
      socket = socketFactory();
      socket.once?.('error', finish);
      timeout = setTimeout(() => finish(new Error('La impresora no respondió a tiempo al envío UDP.')), timeoutMs);
      socket.send(payload, port, host, (error) => finish(error || null));
    } catch (error) {
      finish(error);
    }
  });
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function printerState(status) {
  if (!status.reachable) return 'server_offline';
  if (!status.deviceExists) return 'printer_disconnected';
  if (!status.deviceWritable) return 'permission_error';
  if (status.healthy && (status.currentJob || status.queueDepth > 0)) return 'busy';
  if (status.healthy) return 'online';
  return 'server_offline';
}

export function normalizePrinterStatus(raw, { reachable = true, error = null } = {}) {
  const normalized = {
    reachable,
    healthy: reachable && raw?.healthy === true,
    serviceHealth: !reachable ? 'offline' : raw?.healthy === true ? 'healthy' : 'unhealthy',
    devicePath: typeof raw?.printer?.device === 'string' ? raw.printer.device : null,
    deviceExists: reachable && raw?.printer?.device_exists === true,
    deviceWritable: reachable && raw?.printer?.device_writable === true,
    queueDepth: finiteNumber(raw?.queue?.depth),
    queueCapacity: finiteNumber(raw?.queue?.capacity),
    currentJob: raw?.current_job && typeof raw.current_job === 'object' ? raw.current_job : null,
    lastResult: raw?.last_result && typeof raw.last_result === 'object' ? raw.last_result : null,
    successfulJobs: finiteNumber(raw?.counts?.succeeded),
    failedAttempts: finiteNumber(raw?.counts?.failed_attempts),
    droppedJobs: finiteNumber(raw?.counts?.dropped),
    uptimeSeconds: finiteNumber(raw?.uptime_seconds),
    error: error ? String(error) : null
  };
  normalized.state = printerState(normalized);
  return normalized;
}

export async function fetchPrinterStatus(statusUrl, {
  fetchImpl = fetch,
  timeoutMs = 2_000
} = {}) {
  try {
    const response = await fetchImpl(statusUrl, {
      headers: { accept: 'application/json', 'user-agent': 'rne-panel-dashboard/1.0' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const raw = await response.json();
    return normalizePrinterStatus(raw, {
      reachable: true,
      error: response.ok ? null : `HTTP ${response.status}`
    });
  } catch (error) {
    return normalizePrinterStatus(null, { reachable: false, error: error.message });
  }
}

function wrapLine(value, width) {
  const words = String(value).trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const pieces = [];
    const characters = Array.from(word);
    while (characters.length > width) pieces.push(characters.splice(0, width).join(''));
    pieces.push(characters.join(''));
    for (const piece of pieces.filter(Boolean)) {
      if (!line) line = piece;
      else if (Array.from(`${line} ${piece}`).length <= width) line += ` ${piece}`;
      else {
        lines.push(line);
        line = piece;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function wrapText(value, width = 76) {
  return String(value || '').replace(/\r\n?/g, '\n').split('\n').flatMap((line) => wrapLine(line, width));
}

function printableDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || 'Sin fecha');
  return new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'long', timeStyle: 'medium', timeZone: 'America/Santiago'
  }).format(date);
}

function printableArea(value) {
  return ({
    hospitalario: 'Hospitalario', tramites: 'Trámites', transporte: 'Transporte',
    vivienda: 'Vivienda', otro: 'Otro'
  })[value] || String(value || 'Sin área');
}

function printableWait(minutesValue) {
  const minutes = Number(minutesValue);
  if (!Number.isFinite(minutes)) return 'Sin dato';
  const hours = minutes / 60;
  return `${minutes.toLocaleString('es-CL', { maximumFractionDigits: 1 })} min (${hours.toLocaleString('es-CL', { maximumFractionDigits: 1 })} h)`;
}

export function formatSubmissionPrintJob(entry) {
  const record = entry && typeof entry === 'object' ? entry : {};
  const testimony = record.testimonio || 'Sin testimonio autorizado para publicación.';
  const metadata = [
    'DATOS DEL REGISTRO',
    `ID: ${record.id || 'Sin ID'}`,
    `Fecha: ${printableDate(record.fecha)}`,
    `Área: ${printableArea(record.area)}`,
    `Tiempo de espera: ${printableWait(record.tiempo_minutos)}`,
    `Comuna: ${record.comuna || 'Sin comuna'}`,
    `Región: ${record.region || 'Sin región'}`
  ];
  const knownFields = new Set(['id', 'fecha', 'area', 'tiempo_minutos', 'comuna', 'region', 'testimonio']);
  for (const [key, value] of Object.entries(record)) {
    if (knownFields.has(key)) continue;
    const printable = value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    metadata.push(`${key}: ${printable || '—'}`);
  }

  const separator = '='.repeat(76);
  const testimonyLines = wrapText(testimony);
  const maxLines = 60;
  const prefixLines = [
    'REGISTRO NACIONAL DE ESPERA',
    separator,
    '',
    ...metadata.flatMap((line) => wrapText(line)),
    '',
    '-'.repeat(76),
    '',
    'TESTIMONIO',
    ''
  ];
  const suffixLines = ['', separator, ''];
  const allowedTestimonyLines = Math.max(1, maxLines - prefixLines.length - suffixLines.length);
  let selectedTestimony = testimonyLines.slice(0, allowedTestimonyLines);
  if (testimonyLines.length > selectedTestimony.length) selectedTestimony[selectedTestimony.length - 1] = '[Testimonio acortado para una página]';

  const assemble = () => [...prefixLines, ...selectedTestimony, ...suffixLines].join('\n');
  let output = assemble();
  while (Buffer.byteLength(output, 'utf8') > OKI_MAX_JOB_BYTES && selectedTestimony.length > 1) {
    selectedTestimony.pop();
    selectedTestimony[selectedTestimony.length - 1] = '[Testimonio acortado para una página]';
    output = assemble();
  }
  if (Buffer.byteLength(output, 'utf8') > OKI_MAX_JOB_BYTES) {
    throw new PrinterJobError('Los datos del registro no caben en una página de impresión.', 413);
  }
  return output;
}
