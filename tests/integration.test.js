import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixture = {
  version: 3,
  actualizado_en: '2026-08-29T16:52:26.964Z',
  unidad_tiempo: 'meses',
  tiempo_total: 0.1,
  tiempo_por_area: { hospitalario: 0, tramites: 0.1, transporte: 0, vivienda: 0, otro: 0 },
  entradas: [{
    id: 'KHbkj9jtX0', fecha: '2026-08-29T16:52:26.964Z',
    region: 'Región Metropolitana de Santiago', comuna: 'Santiago',
    area: 'tramites', tiempo_minutos: 2835, testimonio: 'Esperé mucho.'
  }]
};

const summaryFixture = {
  total_submissions: 1,
  total_wait_minutes: 2835,
  average_wait_minutes: 2835,
  median_wait_minutes: 2835,
  updated_at: '2026-08-29T16:52:26.964Z'
};

const categoriesFixture = {
  items: [{
    category: 'tramites', count: 1, total_wait_minutes: 2835,
    average_wait_minutes: 2835, percentage: 100
  }]
};

const bitmapFixture = Buffer.alloc(96 * 96 * 2, 0x5A);
const qrBitmapFixture = await readFile(new URL('../public/assets/rne-qr-96x96.rgb565', import.meta.url));
assert.equal(qrBitmapFixture.readUInt16BE(0), 0x0000, 'QR frame background should be black');
assert.ok(qrBitmapFixture.includes(Buffer.from([0xFF, 0xFF])), 'QR frame should contain white modules');
const chileBitmapFixture = Buffer.alloc(16 * 96 * 2);
for (let index = 0; index < chileBitmapFixture.length; index += 1) {
  chileBitmapFixture[index] = (index * 37) & 0xFF;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for server. Output: ${output}`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(pattern);
      if (match) {
        clearTimeout(timeout);
        resolve(match);
      }
    });
    child.once('exit', (code) => reject(new Error(`Dashboard exited early with ${code}`)));
  });
}

test('polls RNE and routes the formatted result over UDP', async (context) => {
  const udpMessages = [];
  const udp = dgram.createSocket('udp4');
  udp.on('message', (message) => udpMessages.push(message.toString('utf8')));
  const udpPort = await new Promise((resolve) => udp.bind(0, '127.0.0.1', () => resolve(udp.address().port)));

  const printerMessages = [];
  const printerUdp = dgram.createSocket('udp4');
  printerUdp.on('message', (message) => printerMessages.push(Buffer.from(message)));
  const printerPort = await new Promise((resolve) => (
    printerUdp.bind(0, '127.0.0.1', () => resolve(printerUdp.address().port))
  ));

  let bitmapPayload = null;
  let bitmapFrameId = null;
  const bitmapChunks = new Map();
  const bitmapAttempts = [];
  const acknowledgedBitmapFrames = [];
  let firstBitmapAttempts = null;
  let firstBitmapFrameId = null;
  const bitmapUdp = dgram.createSocket('udp4');
  bitmapUdp.on('message', (message, remote) => {
    if (message.length < 8 || message.subarray(0, 4).toString() !== 'RGBU') return;
    const frameId = message.readUInt16BE(4);
    const chunkIndex = message[6];
    const chunkCount = message[7];
    if (chunkCount !== 18 || chunkIndex >= chunkCount) return;
    if (bitmapFrameId !== frameId) {
      bitmapFrameId = frameId;
      bitmapChunks.clear();
      bitmapPayload = null;
      bitmapAttempts.length = 0;
    }
    if (chunkIndex === 0) bitmapAttempts.push([]);
    bitmapAttempts.at(-1)?.push({
      frameId,
      chunkIndex,
      chunkCount,
      payloadLength: message.length - 8
    });
    bitmapChunks.set(chunkIndex, message.subarray(8));
    if (bitmapChunks.size === chunkCount) {
      bitmapPayload = Buffer.concat(Array.from({ length: chunkCount }, (_, index) => bitmapChunks.get(index)));
      const canAcknowledge = acknowledgedBitmapFrames.length > 0 || bitmapAttempts.length >= 2;
      if (canAcknowledge && bitmapAttempts.at(-1).length === chunkCount) {
        const acknowledgement = Buffer.concat([
          Buffer.from('RGBU'), Buffer.from([frameId >> 8, frameId & 0xFF]), Buffer.from('OK')
        ]);
        if (!firstBitmapAttempts) {
          firstBitmapAttempts = bitmapAttempts.map((attempt) => attempt.map((chunk) => ({ ...chunk })));
          firstBitmapFrameId = frameId;
        }
        acknowledgedBitmapFrames.push(Buffer.from(bitmapPayload));
        bitmapUdp.send(acknowledgement, remote.port, remote.address);
      }
    }
  });
  const bitmapPort = await new Promise((resolve) => bitmapUdp.bind(0, '127.0.0.1', () => resolve(bitmapUdp.address().port)));

  let chileBitmapPayload = null;
  let chileBitmapFrameId = null;
  const chileBitmapChunks = new Map();
  const chileBitmapUdp = dgram.createSocket('udp4');
  chileBitmapUdp.on('message', (message, remote) => {
    if (message.length < 8 || message.subarray(0, 4).toString() !== 'RGBU') return;
    const frameId = message.readUInt16BE(4);
    const chunkIndex = message[6];
    const chunkCount = message[7];
    if (chunkCount !== 3 || chunkIndex >= chunkCount) return;
    if (chileBitmapFrameId !== frameId) {
      chileBitmapFrameId = frameId;
      chileBitmapChunks.clear();
    }
    chileBitmapChunks.set(chunkIndex, message.subarray(8));
    if (chileBitmapChunks.size === chunkCount) {
      chileBitmapPayload = Buffer.concat(
        Array.from({ length: chunkCount }, (_, index) => chileBitmapChunks.get(index))
      );
      const acknowledgement = Buffer.concat([
        Buffer.from('RGBU'), Buffer.from([frameId >> 8, frameId & 0xFF]), Buffer.from('OK')
      ]);
      chileBitmapUdp.send(acknowledgement, remote.port, remote.address);
    }
  });
  const chileBitmapPort = await new Promise((resolve) => (
    chileBitmapUdp.bind(0, '127.0.0.1', () => resolve(chileBitmapUdp.address().port))
  ));

  let printerAvailable = true;
  const mockApi = http.createServer((request, reply) => {
    if (request.url === '/printer-healthz') {
      if (!printerAvailable) {
        request.socket.destroy();
        return;
      }
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({
        healthy: true,
        uptime_seconds: 3720,
        current_job: null,
        last_result: { outcome: 'succeeded', bytes_written: 120 },
        counts: { enqueued: 8, succeeded: 7, failed_attempts: 2, dropped: 1 },
        queue: { depth: 0, capacity: 100 },
        printer: {
          device: '/dev/usb/lp0', device_exists: true, device_writable: true, encoding: 'utf-8'
        }
      }));
      return;
    }
    if (request.url === '/api/results/maps/gran-santiago.rgb565') {
      reply.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bitmapFixture.length,
        'x-bitmap-width': '96',
        'x-bitmap-height': '96',
        'x-byte-order': 'big-endian'
      });
      reply.end(bitmapFixture);
      return;
    }
    if (request.url === '/api/results/maps/chile.rgb565') {
      reply.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': chileBitmapFixture.length,
        'x-bitmap-width': '16',
        'x-bitmap-height': '96',
        'x-byte-order': 'big-endian'
      });
      reply.end(chileBitmapFixture);
      return;
    }
    const payload = {
      '/api/results.json': fixture,
      '/api/results': summaryFixture,
      '/api/results/categories': categoriesFixture,
      '/health': { status: 'ok', database: 'ok' }
    }[request.url];
    if (!payload) {
      reply.writeHead(404);
      reply.end();
      return;
    }
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(payload));
  });
  const apiPort = await listen(mockApi);

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rne-dashboard-test-'));
  await writeFile(path.join(dataDir, 'admin-token'), 'test-admin-token\n');
  await writeFile(path.join(dataDir, 'printed-submissions.json'), JSON.stringify({
    version: 1, initialized: true, printed_ids: []
  }));
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    bitmapPanelProvisioned: true,
    chileBitmapPanelProvisioned: true,
    panels: [{
      id: 'test-panel', name: 'Panel test', host: '127.0.0.1', port: udpPort,
      source: 'total', template: '', unit: 'auto', displayMode: 'time', messageLeadingSpaces: 0, enabled: true
    }, {
      id: 'test-panel-minutes', name: 'Panel minutes', host: '127.0.0.1', port: udpPort,
      source: 'total', template: '', unit: 'minutes', displayMode: 'time', messageLeadingSpaces: 2, enabled: true
    }, {
      id: 'test-panel-hours', name: 'Panel hours', host: '127.0.0.1', port: udpPort,
      source: 'total', template: '', unit: 'hours', displayMode: 'time', messageLeadingSpaces: 4, enabled: true
    }, {
      id: 'test-panel-label', name: 'Panel label', host: '127.0.0.1', port: udpPort,
      source: 'tramites', template: '', unit: 'auto', displayMode: 'label',
      colorsEnabled: true, labelColor: '00ff00', messageLeadingSpaces: 6, enabled: true
    }, {
      id: 'test-panel-colors', name: 'Panel colors', host: '127.0.0.1', port: udpPort,
      source: 'tramites', template: '', unit: 'auto', displayMode: 'both',
      colorsEnabled: true, labelColor: '#00ff00', timeColor: 'ff0000', messageLeadingSpaces: 8, enabled: true
    }, {
      id: 'test-panel-map', name: 'Panel map', host: '127.0.0.1', port: bitmapPort,
      source: 'map_gran_santiago', enabled: true
    }, {
      id: 'test-panel-map-chile', name: 'Panel Chile', host: '127.0.0.1', port: chileBitmapPort,
      source: 'map_chile', enabled: true
    }]
  }));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env, NODE_ENV: 'test', RNE_TEST_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      PORT: '0', HOST: '127.0.0.1', RNE_DATA_DIR: dataDir,
      RNE_BITMAP_CHUNK_DELAY_MS: '0',
      RNE_QR_OVERLAY_INITIAL_DELAY_MS: '100',
      RNE_QR_OVERLAY_INTERVAL_MS: '120000',
      RNE_QR_OVERLAY_DURATION_MS: '50',
      OKI_PRINTER_HOST: '127.0.0.1', OKI_PRINTER_PORT: String(printerPort),
      OKI_PRINTER_STATUS_URL: `http://127.0.0.1:${apiPort}/printer-healthz`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  context.after(async () => {
    child.kill('SIGTERM');
    udp.close();
    printerUdp.close();
    bitmapUdp.close();
    chileBitmapUdp.close();
    mockApi.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const match = await waitForOutput(child, /127\.0\.0\.1:(\d+)/);
  const dashboardPort = Number(match[1]);

  for (let attempt = 0; attempt < 80 && (udpMessages.length < 5 || acknowledgedBitmapFrames.length < 3 || !chileBitmapPayload || printerMessages.length < 1); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(udpMessages.sort(), [
    '2 DÍAS', '[FFFF00]  2.835 MIN', '[FFFF00]    47,3 H',
    '[00FF00]      TRÁMITES', '[00FF00]        TRÁMITES [FF0000]2 DÍAS'
  ].sort());
  assert.ok(bitmapPayload);
  assert.equal(bitmapPayload.length, 96 * 96 * 2);
  assert.equal(Buffer.compare(bitmapPayload, bitmapFixture), 0);
  assert.equal(acknowledgedBitmapFrames.length, 3);
  assert.equal(Buffer.compare(acknowledgedBitmapFrames[0], bitmapFixture), 0);
  assert.equal(Buffer.compare(acknowledgedBitmapFrames[1], qrBitmapFixture), 0);
  assert.equal(Buffer.compare(acknowledgedBitmapFrames[2], bitmapFixture), 0);
  assert.ok(chileBitmapPayload);
  assert.equal(chileBitmapPayload.length, 16 * 96 * 2);
  assert.equal(Buffer.compare(chileBitmapPayload, chileBitmapFixture), 0);
  assert.equal(firstBitmapAttempts.length, 2);
  for (const attempt of firstBitmapAttempts) {
    assert.deepEqual(attempt.map((chunk) => chunk.chunkIndex), Array.from({ length: 18 }, (_, index) => index));
    assert.ok(attempt.every((chunk) => chunk.frameId === firstBitmapFrameId));
    assert.ok(attempt.every((chunk) => chunk.chunkCount === 18));
    assert.ok(attempt.every((chunk) => chunk.payloadLength > 0 && chunk.payloadLength <= 1024));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));

  const stateResponse = await fetch(`http://127.0.0.1:${dashboardPort}/api/state`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.results.tiempo_total, 2835);
  assert.equal(state.results.tiempo_por_area.tramites, 2835);
  assert.equal(state.results.tiempo_por_area.hospitalario, 0);
  assert.equal(state.results.unidad_tiempo, 'minutos');
  assert.equal(state.results.version, 3);
  assert.equal(state.defaultTextPanelLeadingSpaces, 2);
  assert.deepEqual(state.qrOverlay, {
    enabled: true,
    active: false,
    intervalSeconds: 120,
    durationSeconds: 0.05,
    startedAt: null,
    endsAt: null
  });
  assert.equal(state.health.status, 'ok');
  assert.equal(state.events.filter((event) => event.kind === 'api').length, 6);
  assert.equal(state.events.filter((event) => event.kind === 'udp').length, 9);
  assert.equal(state.events.filter((event) => event.kind === 'printer').length, 2);
  assert.equal(state.panelRuntime['test-panel-map'].ok, true);
  assert.equal(state.panelRuntime['test-panel-map-chile'].ok, true);
  const coloredPanel = state.config.panels.find((panel) => panel.id === 'test-panel-colors');
  assert.equal(coloredPanel.labelColor, '00FF00');
  assert.equal(coloredPanel.timeColor, 'FF0000');
  assert.equal(coloredPanel.colorsEnabled, true);
  assert.equal(coloredPanel.messageLeadingSpaces, 8);

  assert.equal(printerMessages.length, 1);
  const automaticPrint = printerMessages[0].toString('utf8');
  assert.match(automaticPrint, /TESTIMONIO[\s\S]*Esperé mucho\./);
  assert.match(automaticPrint, /ID: KHbkj9jtX0/);
  assert.ok(automaticPrint.indexOf('ID: KHbkj9jtX0') < automaticPrint.indexOf('TESTIMONIO'));
  const printedState = JSON.parse(await readFile(path.join(dataDir, 'printed-submissions.json'), 'utf8'));
  assert.deepEqual(printedState.printed_ids, ['KHbkj9jtX0']);

  const printerStatusResponse = await fetch(`http://127.0.0.1:${dashboardPort}/api/printer/status`);
  assert.equal(printerStatusResponse.status, 200);
  const printerStatus = await printerStatusResponse.json();
  assert.equal(printerStatus.state, 'online');
  assert.equal(printerStatus.devicePath, '/dev/usb/lp0');
  assert.equal(printerStatus.queueDepth, 0);
  assert.equal(printerStatus.queueCapacity, 100);
  assert.equal(printerStatus.successfulJobs, 7);
  assert.equal(printerStatus.dashboardQueueDepth, 0);

  const unauthenticatedPrint = await fetch(`http://127.0.0.1:${dashboardPort}/api/printer/print`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'no autorizado' })
  });
  assert.equal(unauthenticatedPrint.status, 401);

  const printerHeaders = { 'content-type': 'application/json', 'x-rne-admin-token': 'test-admin-token' };
  const emptyPrint = await fetch(`http://127.0.0.1:${dashboardPort}/api/printer/print`, {
    method: 'POST', headers: printerHeaders, body: JSON.stringify({ text: '  \n ' })
  });
  assert.equal(emptyPrint.status, 400);
  const oversizedPrint = await fetch(`http://127.0.0.1:${dashboardPort}/api/printer/print`, {
    method: 'POST', headers: printerHeaders, body: JSON.stringify({ text: 'á'.repeat(4097) })
  });
  assert.equal(oversizedPrint.status, 413);

  const manualText = 'Español Ñ\n  espacios conservados';
  const manualPrint = await fetch(`http://127.0.0.1:${dashboardPort}/api/printer/print`, {
    method: 'POST', headers: printerHeaders, body: JSON.stringify({ text: manualText })
  });
  assert.equal(manualPrint.status, 200);
  const manualResult = await manualPrint.json();
  assert.equal(manualResult.success, true);
  assert.equal(manualResult.bytes, Buffer.byteLength(manualText, 'utf8'));
  assert.match(manualResult.notice, /no garantiza la impresión física/);
  for (let attempt = 0; attempt < 20 && printerMessages.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(printerMessages.length, 2);
  assert.equal(printerMessages[1].toString('utf8'), manualText);

  printerAvailable = false;
  const offlineText = 'Trabajo guardado mientras la impresora está apagada';
  const queuedPrint = await fetch(`http://127.0.0.1:${dashboardPort}/api/printer/print`, {
    method: 'POST', headers: printerHeaders, body: JSON.stringify({ text: offlineText })
  });
  assert.equal(queuedPrint.status, 202);
  const queuedResult = await queuedPrint.json();
  assert.equal(queuedResult.success, true);
  assert.equal(queuedResult.queued, true);
  assert.match(queuedResult.notice, /quedó guardado/);
  assert.equal(printerMessages.length, 2);
  const savedQueue = JSON.parse(await readFile(path.join(dataDir, 'printer-queue.json'), 'utf8'));
  assert.equal(savedQueue.jobs.length, 1);
  assert.equal(savedQueue.jobs[0].text, offlineText);

  const offlineStatus = await (await fetch(`http://127.0.0.1:${dashboardPort}/api/printer/status`)).json();
  assert.equal(offlineStatus.state, 'server_offline');
  assert.equal(offlineStatus.dashboardQueueDepth, 1);

  printerAvailable = true;
  await fetch(`http://127.0.0.1:${dashboardPort}/api/printer/status`);
  for (let attempt = 0; attempt < 40 && printerMessages.length < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(printerMessages.length, 3);
  assert.equal(printerMessages[2].toString('utf8'), offlineText);
  const emptiedQueue = JSON.parse(await readFile(path.join(dataDir, 'printer-queue.json'), 'utf8'));
  assert.deepEqual(emptiedQueue.jobs, []);

  await fetch(`http://127.0.0.1:${dashboardPort}/api/sync`, { method: 'POST' });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const current = await (await fetch(`http://127.0.0.1:${dashboardPort}/api/state`)).json();
    if (!current.polling && attempt > 0) break;
  }
  assert.equal(printerMessages.length, 3, 'already printed submission IDs must not print twice');

  const protectedResponse = await fetch(`http://127.0.0.1:${dashboardPort}/api/network/ipv4`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(protectedResponse.status, 401);

  const pageResponse = await fetch(`http://127.0.0.1:${dashboardPort}/`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /CHASKI · Control RNE/);
  assert.match(page, /Usar colores RGB/);
  assert.match(page, /Desfase del scroll \(espacios iniciales\)/);
  assert.match(page, /Mapa de Chile 16×96/);
  assert.match(page, /OKI Microline 320/);
  assert.match(page, /id="printerSubmitButton"/);
  assert.match(page, /id="printerTestButton"/);

  const logoResponse = await fetch(`http://127.0.0.1:${dashboardPort}/assets/chaski-mark.svg`);
  assert.equal(logoResponse.status, 200);
  assert.match(logoResponse.headers.get('content-type'), /image\/svg\+xml/);

  const fontResponse = await fetch(`http://127.0.0.1:${dashboardPort}/assets/fonts/geist-sans.woff`);
  assert.equal(fontResponse.status, 200);
  assert.equal(fontResponse.headers.get('content-type'), 'font/woff');
  assert.ok((await fontResponse.arrayBuffer()).byteLength > 60_000);
});
