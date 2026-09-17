import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  OKI_MAX_JOB_BYTES,
  PrinterJobError,
  encodePrinterJob,
  fetchPrinterStatus,
  formatSubmissionPrintJob,
  normalizePrinterStatus,
  sendPrinterJob
} from '../printer-service.js';
import {
  buildTestPrintText,
  printSubmissionDisabled,
  printerStatusView,
  utf8ByteLength
} from '../public/printer-ui.js';

class MockSocket extends EventEmitter {
  constructor(sendImplementation) {
    super();
    this.sendImplementation = sendImplementation;
    this.sent = [];
    this.closed = false;
  }

  send(payload, port, host, callback) {
    this.sent.push({ payload: Buffer.from(payload), port, host });
    this.sendImplementation?.(callback);
  }

  close() {
    this.closed = true;
  }
}

test('validates empty, UTF-8 and oversized printer jobs by encoded bytes', () => {
  assert.throws(() => encodePrinterJob('  \n '), PrinterJobError);
  assert.equal(encodePrinterJob('Español Ñ').length, Buffer.byteLength('Español Ñ', 'utf8'));
  assert.equal(utf8ByteLength('Ñ'), 2);
  assert.equal(encodePrinterJob('a'.repeat(OKI_MAX_JOB_BYTES)).length, OKI_MAX_JOB_BYTES);
  assert.throws(
    () => encodePrinterJob('á'.repeat((OKI_MAX_JOB_BYTES / 2) + 1)),
    (error) => error instanceof PrinterJobError && error.statusCode === 413
  );
});

test('sends exactly one complete UDP datagram and closes its socket', async () => {
  const socket = new MockSocket((callback) => callback(null));
  const result = await sendPrinterJob('línea uno\nlínea dos', {
    host: '192.168.100.10', port: 5005, sender: 'test-user',
    socketFactory: () => socket, logger: { info() {}, error() {} }
  });
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].payload.toString('utf8'), 'línea uno\nlínea dos');
  assert.equal(socket.sent[0].host, '192.168.100.10');
  assert.equal(socket.sent[0].port, 5005);
  assert.equal(result.bytes, Buffer.byteLength('línea uno\nlínea dos'));
  assert.equal(socket.closed, true);
});

test('reports socket errors and timeouts without leaking sockets', async () => {
  const failedSocket = new MockSocket((callback) => callback(new Error('network unreachable')));
  await assert.rejects(
    sendPrinterJob('test', {
      host: 'bad-host', port: 5005, socketFactory: () => failedSocket,
      logger: { info() {}, error() {} }
    }),
    /network unreachable/
  );
  assert.equal(failedSocket.closed, true);

  const stalledSocket = new MockSocket(() => {});
  await assert.rejects(
    sendPrinterJob('test', {
      host: '192.168.100.10', port: 5005, timeoutMs: 5,
      socketFactory: () => stalledSocket, logger: { info() {}, error() {} }
    }),
    /no respondió a tiempo/
  );
  assert.equal(stalledSocket.closed, true);
});

const healthyStatus = {
  healthy: true,
  uptime_seconds: 3720,
  current_job: null,
  last_result: { outcome: 'succeeded', bytes_written: 120 },
  counts: { succeeded: 7, failed_attempts: 2, dropped: 1 },
  queue: { depth: 0, capacity: 100 },
  printer: { device: '/dev/usb/lp0', device_exists: true, device_writable: true }
};

test('normalizes printer status and every dashboard UI state', () => {
  const online = normalizePrinterStatus(healthyStatus);
  assert.equal(online.state, 'online');
  assert.equal(online.devicePath, '/dev/usb/lp0');
  assert.equal(online.queueCapacity, 100);
  assert.equal(online.successfulJobs, 7);
  assert.equal(printerStatusView(online).label, 'Online');

  const busy = normalizePrinterStatus({ ...healthyStatus, current_job: { description: 'text' } });
  assert.equal(busy.state, 'busy');
  assert.equal(printerStatusView(busy).label, 'Ocupada');

  const disconnected = normalizePrinterStatus({
    ...healthyStatus, printer: { ...healthyStatus.printer, device_exists: false, device_writable: false }
  });
  assert.equal(disconnected.state, 'printer_disconnected');
  assert.equal(printerStatusView(disconnected).label, 'Impresora desconectada');

  const permission = normalizePrinterStatus({
    ...healthyStatus, printer: { ...healthyStatus.printer, device_writable: false }
  });
  assert.equal(permission.state, 'permission_error');
  assert.equal(printerStatusView(permission).label, 'Error de permisos');

  const offline = normalizePrinterStatus(null, { reachable: false, error: 'timeout' });
  assert.equal(offline.state, 'server_offline');
  assert.equal(printerStatusView(offline).label, 'Servidor offline');
});

test('returns a useful normalized offline status after a network failure', async () => {
  const status = await fetchPrinterStatus('http://192.168.100.10:8080/healthz', {
    fetchImpl: async () => { throw new Error('connect timeout'); }, timeoutMs: 5
  });
  assert.equal(status.reachable, false);
  assert.equal(status.serviceHealth, 'offline');
  assert.equal(status.error, 'connect timeout');
});

test('formats every public submission field before the testimony on one page', () => {
  const job = formatSubmissionPrintJob({
    id: 'KHbkj9jtX0', fecha: '2026-08-29T16:52:26.964Z', area: 'tramites',
    tiempo_minutos: 2835, comuna: 'Santiago', region: 'Región Metropolitana de Santiago',
    testimonio: 'Esperé mucho.\nNadie entregó información.', extra_publico: 'dato adicional'
  });
  assert.match(job, /TESTIMONIO[\s\S]*Esperé mucho\./);
  assert.match(job, /ID: KHbkj9jtX0/);
  assert.match(job, /Área: Trámites/);
  assert.match(job, /Tiempo de espera: 2\.835 min \(47,3 h\)/);
  assert.match(job, /Comuna: Santiago/);
  assert.match(job, /Región: Región Metropolitana de Santiago/);
  assert.match(job, /extra_publico: dato adicional/);
  assert.ok(job.indexOf('DATOS DEL REGISTRO') < job.indexOf('TESTIMONIO'));
  assert.ok(job.indexOf('Región: Región Metropolitana de Santiago') < job.indexOf('TESTIMONIO'));
  assert.ok(job.split('\n').length <= 60);
  assert.ok(Buffer.byteLength(job, 'utf8') <= OKI_MAX_JOB_BYTES);
});

test('builds the requested test print and enforces button disabled states', () => {
  const testPrint = buildTestPrintText(new Date('2026-09-17T12:34:56-03:00'));
  assert.match(testPrint, /^RNE DASHBOARD TEST\nDate: /);
  assert.match(testPrint, /Printer: OKI Microline 320/);
  assert.match(testPrint, /Server: 192\.168\.100\.10$/);
  assert.equal(printSubmissionDisabled('', false), true);
  assert.equal(printSubmissionDisabled('texto', true), true);
  assert.equal(printSubmissionDisabled('á'.repeat(4097), false), true);
  assert.equal(printSubmissionDisabled('texto', false), false);
});
