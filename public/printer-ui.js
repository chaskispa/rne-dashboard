export const PRINTER_MAX_BYTES = 8192;

export function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value || '')).length;
}

export function printerStatusView(status) {
  const views = {
    online: { label: 'Online', detail: 'Servicio y dispositivo listos.' },
    busy: { label: 'Ocupada', detail: 'Imprimiendo o con trabajos en cola.' },
    printer_disconnected: { label: 'Impresora desconectada', detail: 'El servidor responde, pero no encuentra el dispositivo.' },
    permission_error: { label: 'Error de permisos', detail: 'El dispositivo existe, pero el servicio no puede escribir en él.' },
    server_offline: { label: 'Servidor offline', detail: 'No fue posible consultar el servidor de impresión.' }
  };
  return views[status?.state] || views.server_offline;
}

export function buildTestPrintText(date = new Date()) {
  return [
    'RNE DASHBOARD TEST',
    `Date: ${date.toLocaleString('es-CL')}`,
    'Printer: OKI Microline 320',
    'Server: 192.168.100.10'
  ].join('\n');
}

export function printSubmissionDisabled(text, loading) {
  const bytes = utf8ByteLength(text);
  return Boolean(loading) || !String(text || '').trim() || bytes > PRINTER_MAX_BYTES;
}
