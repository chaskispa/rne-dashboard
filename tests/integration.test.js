import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  let bitmapPayload = null;
  let bitmapFrameId = null;
  const bitmapChunks = new Map();
  const bitmapAttempts = [];
  let bitmapAcknowledged = false;
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
      if (bitmapAttempts.length >= 2 && bitmapAttempts.at(-1).length === chunkCount) {
        const acknowledgement = Buffer.concat([
          Buffer.from('RGBU'), Buffer.from([frameId >> 8, frameId & 0xFF]), Buffer.from('OK')
        ]);
        bitmapAcknowledged = true;
        bitmapUdp.send(acknowledgement, remote.port, remote.address);
      }
    }
  });
  const bitmapPort = await new Promise((resolve) => bitmapUdp.bind(0, '127.0.0.1', () => resolve(bitmapUdp.address().port)));

  const mockApi = http.createServer((request, reply) => {
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
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    bitmapPanelProvisioned: true,
    panels: [{
      id: 'test-panel', name: 'Panel test', host: '127.0.0.1', port: udpPort,
      source: 'total', template: '', unit: 'auto', displayMode: 'time', enabled: true
    }, {
      id: 'test-panel-minutes', name: 'Panel minutes', host: '127.0.0.1', port: udpPort,
      source: 'total', template: '', unit: 'minutes', displayMode: 'time', enabled: true
    }, {
      id: 'test-panel-hours', name: 'Panel hours', host: '127.0.0.1', port: udpPort,
      source: 'total', template: '', unit: 'hours', displayMode: 'time', enabled: true
    }, {
      id: 'test-panel-label', name: 'Panel label', host: '127.0.0.1', port: udpPort,
      source: 'tramites', template: '', unit: 'auto', displayMode: 'label',
      colorsEnabled: true, labelColor: '00ff00', enabled: true
    }, {
      id: 'test-panel-colors', name: 'Panel colors', host: '127.0.0.1', port: udpPort,
      source: 'tramites', template: '', unit: 'auto', displayMode: 'both',
      colorsEnabled: true, labelColor: '#00ff00', timeColor: 'ff0000', enabled: true
    }, {
      id: 'test-panel-map', name: 'Panel map', host: '127.0.0.1', port: bitmapPort,
      source: 'map_gran_santiago', enabled: true
    }]
  }));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env, NODE_ENV: 'test', RNE_TEST_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      PORT: '0', HOST: '127.0.0.1', RNE_DATA_DIR: dataDir,
      RNE_BITMAP_CHUNK_DELAY_MS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  context.after(async () => {
    child.kill('SIGTERM');
    udp.close();
    bitmapUdp.close();
    mockApi.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const match = await waitForOutput(child, /127\.0\.0\.1:(\d+)/);
  const dashboardPort = Number(match[1]);

  for (let attempt = 0; attempt < 80 && (udpMessages.length < 5 || !bitmapAcknowledged); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(udpMessages.sort(), [
    '2 DÍAS', '2.835 MIN', '47,3 H',
    '[00FF00]TRÁMITES', '[00FF00]TRÁMITES [FF0000]2 DÍAS'
  ].sort());
  assert.ok(bitmapPayload);
  assert.equal(bitmapPayload.length, 96 * 96 * 2);
  assert.equal(Buffer.compare(bitmapPayload, bitmapFixture), 0);
  assert.equal(bitmapAttempts.length, 2);
  for (const attempt of bitmapAttempts) {
    assert.deepEqual(attempt.map((chunk) => chunk.chunkIndex), Array.from({ length: 18 }, (_, index) => index));
    assert.ok(attempt.every((chunk) => chunk.frameId === bitmapFrameId));
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
  assert.equal(state.health.status, 'ok');
  assert.equal(state.events.filter((event) => event.kind === 'api').length, 5);
  assert.equal(state.events.filter((event) => event.kind === 'udp').length, 6);
  assert.equal(state.panelRuntime['test-panel-map'].ok, true);
  const coloredPanel = state.config.panels.find((panel) => panel.id === 'test-panel-colors');
  assert.equal(coloredPanel.labelColor, '00FF00');
  assert.equal(coloredPanel.timeColor, 'FF0000');
  assert.equal(coloredPanel.colorsEnabled, true);

  const protectedResponse = await fetch(`http://127.0.0.1:${dashboardPort}/api/network/ipv4`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(protectedResponse.status, 401);

  const pageResponse = await fetch(`http://127.0.0.1:${dashboardPort}/`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /CHASKI · Control RNE/);
  assert.match(page, /Usar colores RGB/);

  const logoResponse = await fetch(`http://127.0.0.1:${dashboardPort}/assets/chaski-mark.svg`);
  assert.equal(logoResponse.status, 200);
  assert.match(logoResponse.headers.get('content-type'), /image\/svg\+xml/);

  const fontResponse = await fetch(`http://127.0.0.1:${dashboardPort}/assets/fonts/geist-sans.woff`);
  assert.equal(fontResponse.status, 200);
  assert.equal(fontResponse.headers.get('content-type'), 'font/woff');
  assert.ok((await fontResponse.arrayBuffer()).byteLength > 60_000);
});
