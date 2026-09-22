import {
  PRINTER_MAX_BYTES,
  buildTestPrintText,
  printSubmissionDisabled,
  printerStatusView,
  utf8ByteLength
} from './printer-ui.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  data: null, network: null, printer: null, printerSending: false,
  printerTimer: null, filter: 'all', tick: null, toastTimer: null
};
const sourceLabels = {
  total: 'Tiempo total', hospitalario: 'Hospitalario', tramites: 'Trámites',
  transporte: 'Transporte', vivienda: 'Vivienda', otro: 'Otro',
  latest_wait: 'Última espera', latest_testimony: 'Último testimonio',
  map_gran_santiago: 'Mapa Gran Santiago 96×96', map_chile: 'Mapa de Chile 16×96',
  custom: 'Plantilla personalizada'
};
const categoryLabels = {
  hospitalario: 'Hospitalario', tramites: 'Trámites', transporte: 'Transporte',
  vivienda: 'Vivienda', otro: 'Otro'
};
const timedSources = ['total', 'hospitalario', 'tramites', 'transporte', 'vivienda', 'otro', 'latest_wait'];
const bitmapSources = ['map_gran_santiago', 'map_chile'];
const bitmapSourceDetails = {
  map_gran_santiago: 'RGB565 · 96×96 · con confirmación',
  map_chile: 'RGB565 · 16×96 · con confirmación'
};
const unitLabels = {
  auto: 'Unidad automática', minutes: 'Minutos', hours: 'Horas', days: 'Días', months: 'Meses', years: 'Años'
};
const displayModeLabels = { both: 'Etiqueta + tiempo', time: 'Solo tiempo', label: 'Solo etiqueta' };

function panelDisplayMode(panel) {
  return panel.displayMode || (panel.showLabel === false ? 'time' : 'both');
}

function panelFormatSummary(panel) {
  const mode = panelDisplayMode(panel);
  const unit = mode === 'label' ? '' : ` · ${unitLabels[panel.unit || 'auto']}`;
  const color = panel.colorsEnabled ? ' · RGB' : '';
  return `${displayModeLabels[mode]}${unit}${color}`;
}

function panelMessageLeadingSpaces(panel) {
  if (Number.isInteger(panel?.messageLeadingSpaces)) return panel.messageLeadingSpaces;
  const textPanels = state.data?.config.panels.filter((item) => !bitmapSources.includes(item.source)) || [];
  const index = Math.max(0, textPanels.findIndex((item) => item.id === panel?.id));
  return Math.min(40, index * (state.data?.defaultTextPanelLeadingSpaces ?? 2));
}

function formatMessageLeadingSpaces(panel) {
  const spaces = panelMessageLeadingSpaces(panel);
  return `${spaces} espacio${spaces === 1 ? '' : 's'} de desfase`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}

function formatTime(value, withSeconds = false) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-CL', {
    hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {})
  }).format(new Date(value));
}

function relativeTime(value) {
  if (!value) return 'Nunca actualizado';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 5) return 'Actualizado ahora';
  if (seconds < 60) return `Actualizado hace ${seconds} s`;
  return `Actualizado a las ${formatTime(value)}`;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove('show'), 2500);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function renderSummary() {
  const data = state.data;
  const results = data.results;
  const total = results?.tiempo_total;
  $('#totalTime').textContent = Number.isFinite(total) ? `${(total / 60).toLocaleString('es-CL', { maximumFractionDigits: 1 })} h` : '—';
  $('#totalMinutes').textContent = Number.isFinite(total) ? `${total.toLocaleString('es-CL')} minutos registrados` : 'Esperando datos';

  const apiOk = data.health?.status === 'ok';
  $('#apiStatus').textContent = apiOk ? 'Operativa' : (data.polling ? 'Consultando…' : 'Sin conexión');
  $('#apiDetail').textContent = apiOk ? `SQLite ${data.health.database === 'ok' ? 'responde correctamente' : data.health.database}` : `Origen: ${data.apiBaseUrl}`;
  $('#liveState').classList.toggle('online', apiOk);
  $('#liveState').lastElementChild.textContent = apiOk ? 'Sistema activo' : (data.polling ? 'Consultando' : 'Atención requerida');

  $('#activeRoutes').textContent = data.activePanels;
  $('#routeDetail').textContent = data.config.panels.length
    ? `${data.config.panels.length} panel${data.config.panels.length === 1 ? '' : 'es'} configurado${data.config.panels.length === 1 ? '' : 's'}`
    : 'Agrega el primer panel';
  $('#lastUpdate').textContent = relativeTime(data.lastPollAt);
  $('#dataTimestamp').textContent = results?.actualizado_en ? `Datos del ${new Date(results.actualizado_en).toLocaleString('es-CL')}` : 'Sin datos';
}

function updateCountdown() {
  if (!state.data) return;
  if (state.data.polling) {
    $('#countdown').textContent = 'Ahora';
    return;
  }
  const remaining = state.data.nextPollAt
    ? Math.max(0, Math.ceil((new Date(state.data.nextPollAt).getTime() - Date.now()) / 1000))
    : null;
  $('#countdown').textContent = remaining === null ? '—' : `${remaining} s`;
  $('#lastUpdate').textContent = relativeTime(state.data.lastPollAt);
}

function ledIcon() {
  return `<span class="panel-icon" aria-hidden="true">${'<i></i>'.repeat(18)}</span>`;
}

function renderPanels() {
  const list = $('#panelList');
  const panels = state.data.config.panels;
  if (!panels.length) {
    list.innerHTML = '<div class="empty"><strong>No hay rutas configuradas</strong>Conecta un controlador RGB Ethernet para comenzar a enviar datos.</div>';
    return;
  }
  list.innerHTML = panels.map((panel) => {
    const runtime = state.data.panelRuntime[panel.id];
    const statusText = !panel.enabled ? 'Pausada' : runtime
      ? `${runtime.ok ? 'Enviado' : 'Error'} · ${formatTime(runtime.at, true)}`
      : 'Esperando primer envío';
    const statusClass = !panel.enabled ? '' : runtime?.ok ? 'ok' : runtime ? 'error' : '';
    const formatSummary = timedSources.includes(panel.source)
      ? panelFormatSummary(panel)
      : bitmapSources.includes(panel.source) ? bitmapSourceDetails[panel.source]
      : panel.source === 'custom' ? (panel.template || 'Plantilla personalizada') : 'Texto público';
    const routeSummary = bitmapSources.includes(panel.source)
      ? formatSummary
      : `${formatSummary} · ${formatMessageLeadingSpaces(panel)}`;
    return `<article class="panel-row ${panel.enabled ? '' : 'disabled'}" data-panel-id="${escapeHtml(panel.id)}">
      ${ledIcon()}
      <div><p class="panel-name">${escapeHtml(panel.name)}</p><div class="panel-meta">${escapeHtml(panel.host)}:${panel.port}</div><div class="send-status"><i class="status-dot ${statusClass}"></i>${escapeHtml(statusText)}</div></div>
      <div class="route-source"><strong>${escapeHtml(sourceLabels[panel.source] || panel.source)}</strong>${escapeHtml(routeSummary)}</div>
      <div class="panel-actions">
        <button class="small-action" data-action="test" title="${bitmapSources.includes(panel.source) ? 'Reenviar mapa' : 'Enviar prueba'}" aria-label="Probar ${escapeHtml(panel.name)}">${bitmapSources.includes(panel.source) ? 'Reenviar' : 'Probar'}</button>
        <button class="small-action" data-action="edit" title="Editar" aria-label="Editar ${escapeHtml(panel.name)}">Editar</button>
        <button class="small-action" data-action="delete" title="Eliminar" aria-label="Eliminar ${escapeHtml(panel.name)}">×</button>
      </div>
    </article>`;
  }).join('');
}

function renderAreas() {
  const area = state.data.results?.tiempo_por_area || {};
  const max = Math.max(1, ...Object.values(area).map(Number));
  $('#areaBars').innerHTML = Object.entries(categoryLabels).map(([key, label]) => {
    const value = Number(area[key] || 0);
    const width = value ? Math.max(1.5, value / max * 100) : 0;
    return `<div class="area-row"><span class="area-label">${label}</span><div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div><span class="area-value">${value.toLocaleString('es-CL')} min</span></div>`;
  }).join('');
}

function renderLan() {
  const lan = state.data.lan || { devices: [] };
  const devices = lan.devices || [];
  const button = $('#scanLanButton');
  button.disabled = Boolean(lan.scanning);
  button.textContent = lan.scanning ? 'Escaneando…' : 'Escanear red';
  $('#lanCount').textContent = devices.length;
  $('#lanTimestamp').textContent = lan.scanning
    ? 'Escaneo en curso'
    : lan.lastScanAt ? `Escaneado ${formatTime(lan.lastScanAt, true)}` : 'Sin escanear';

  const table = $('.lan-table-wrap');
  const empty = $('#lanEmpty');
  if (!devices.length) {
    table.hidden = true;
    empty.hidden = false;
    const title = lan.scanning ? 'Buscando dispositivos' : lan.available === false ? 'Escaneo no disponible' : 'Todavía no hay resultados';
    const detail = lan.error || (lan.scanning ? 'Esto puede tardar algunos segundos.' : 'Inicia un escaneo para descubrir la red local.');
    empty.innerHTML = `<strong>${escapeHtml(title)}</strong>${escapeHtml(detail)}`;
    return;
  }

  table.hidden = false;
  empty.hidden = true;
  $('#lanDeviceList').innerHTML = devices.map((device) => {
    const panel = state.data.config.panels.find((item) => (
      item.host.toLowerCase() === device.ip.toLowerCase()
      || (device.hostname && item.host.toLowerCase() === device.hostname.toLowerCase())
    ));
    const name = device.hostname || panel?.name || 'Dispositivo sin nombre';
    const badge = panel ? '<span class="device-badge">Panel LED</span>'
      : device.local ? '<span class="device-badge local">Esta Raspberry</span>' : '';
    return `<tr>
      <td><div class="device-identity"><span class="device-symbol" aria-hidden="true">${panel ? 'LED' : device.local ? 'PI' : 'LAN'}</span><div><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong>${badge}</div></div></td>
      <td><code>${escapeHtml(device.ip)}</code></td>
      <td><code>${escapeHtml(device.mac || '—')}</code></td>
      <td title="${escapeHtml(device.vendor)}">${escapeHtml(device.vendor)}</td>
      <td>${escapeHtml(device.interface)}</td>
    </tr>`;
  }).join('');
}

function renderEvents() {
  const events = state.data.events.filter((event) => state.filter === 'all' || event.kind === state.filter);
  const list = $('#activityList');
  if (!events.length) {
    list.innerHTML = '<div class="empty"><strong>Sin actividad todavía</strong>Las consultas y envíos aparecerán aquí.</div>';
    return;
  }
  list.innerHTML = events.slice(0, 40).map((event) => {
    const result = ['udp', 'printer'].includes(event.kind) ? (event.ok ? 'ENVIADO' : 'ERROR')
      : event.kind === 'api' ? (event.status || 'ERROR') : 'OK';
    return `<article class="event ${event.kind}">
      <span class="event-method">${escapeHtml(event.method)}</span>
      <div class="event-target" title="${escapeHtml(event.target)}">${escapeHtml(event.panelName || event.target)}</div>
      <div class="event-result"><div class="event-code ${event.ok ? 'ok' : 'error'}">${escapeHtml(result)}</div><div class="event-time">${formatTime(event.at, true)}</div></div>
    </article>`;
  }).join('');
}

function storedAdminKey() {
  return sessionStorage.getItem('rneAdminKey') || sessionStorage.getItem('rneNetworkAdminKey') || '';
}

function adminHeaders(value) {
  const key = String(value ?? $('#networkAdminKey')?.value ?? storedAdminKey()).trim();
  if (key) {
    sessionStorage.setItem('rneAdminKey', key);
    sessionStorage.setItem('rneNetworkAdminKey', key);
  }
  return { 'x-rne-admin-token': key };
}

function formatUptime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '—';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return days ? `${days} d ${hours} h` : hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function renderPrinterStatus() {
  const printer = state.printer;
  const view = printerStatusView(printer);
  const stateNode = $('#printerState');
  stateNode.textContent = view.label;
  stateNode.dataset.state = printer?.state || 'server_offline';
  $('#printerStateDetail').textContent = printer?.error || view.detail;
  $('#printerDevice').textContent = printer?.devicePath || '—';
  const serverQueue = printer?.reachable ? `${printer.queueDepth} / ${printer.queueCapacity}` : 'offline';
  $('#printerQueue').textContent = `Servidor ${serverQueue} · Dashboard ${printer?.dashboardQueueDepth ?? 0}`;
  $('#printerCurrentJob').textContent = printer?.currentJob?.description || 'Ninguno';
  $('#printerLastResult').textContent = printer?.lastResult?.outcome === 'succeeded'
    ? 'Correcto' : printer?.lastResult?.message || 'Sin resultados';
  $('#printerSuccessCount').textContent = printer?.successfulJobs ?? 0;
  $('#printerFailureCount').textContent = printer?.failedAttempts ?? 0;
  $('#printerDroppedCount').textContent = printer?.droppedJobs ?? 0;
  $('#printerUptime').textContent = printer?.reachable ? formatUptime(printer.uptimeSeconds) : '—';
  if (printer?.controlUrl) $('#printerControlLink').href = printer.controlUrl;
}

function updatePrinterForm() {
  const text = $('#printerText').value;
  const bytes = utf8ByteLength(text);
  const counter = $('#printerByteCount');
  counter.textContent = `${bytes.toLocaleString('es-CL')} / ${PRINTER_MAX_BYTES.toLocaleString('es-CL')} bytes`;
  counter.classList.toggle('over-limit', bytes > PRINTER_MAX_BYTES);
  $('#printerSubmitButton').disabled = printSubmissionDisabled(text, state.printerSending);
  $('#printerTestButton').disabled = state.printerSending;
  $('#printerSubmitButton').textContent = state.printerSending ? 'Enviando…' : 'Imprimir texto';
}

async function refreshPrinterStatus() {
  clearTimeout(state.printerTimer);
  if (document.hidden) return;
  try {
    state.printer = await request('/api/printer/status');
  } catch (error) {
    state.printer = { state: 'server_offline', reachable: false, error: error.message };
  }
  renderPrinterStatus();
  state.printerTimer = setTimeout(refreshPrinterStatus, 8_000);
}

async function submitPrinterText(text) {
  if (state.printerSending) return;
  state.printerSending = true;
  $('#printerError').textContent = '';
  updatePrinterForm();
  try {
    const result = await request('/api/printer/print', {
      method: 'POST',
      headers: adminHeaders($('#printerAdminKey').value),
      body: JSON.stringify({ text })
    });
    toast(result.notice || 'Trabajo enviado a la Raspberry Pi');
    await refreshPrinterStatus();
  } catch (error) {
    $('#printerError').textContent = error.message;
    toast(`Error de impresión: ${error.message}`);
  } finally {
    state.printerSending = false;
    updatePrinterForm();
  }
}

function selectNetworkConnection() {
  const device = state.network?.devices.find((item) => item.uuid === $('#networkConnection').value);
  if (!device) return;
  $('#networkMethod').value = device.method === 'manual' ? 'manual' : 'auto';
  $('#networkAddress').value = device.addresses?.[0] || '';
  $('#networkGateway').value = device.gateway || '';
  $('#networkDns').value = (device.dns || []).join(', ');
  $('#staticNetworkFields').hidden = $('#networkMethod').value !== 'manual';
}

function renderNetwork() {
  const network = state.network;
  const status = $('#networkStatus');
  if (!network?.available) {
    status.innerHTML = `<div class="empty"><strong>NetworkManager no disponible</strong>${escapeHtml(network?.error || 'No se pudo consultar nmcli.')}</div>`;
    $('#ipv4Form').hidden = true;
    $('#wifiForm').hidden = true;
    return;
  }

  $('#ipv4Form').hidden = false;
  const devices = network.devices || [];
  status.innerHTML = devices.length ? devices.map((device) => `
    <div class="network-device">
      <strong>${escapeHtml(device.device)} · ${device.type === 'wifi' ? 'Wi-Fi' : 'Ethernet'}</strong>
      <span title="${escapeHtml(device.connection || device.state)}">${escapeHtml(device.connection || device.state)}</span>
      <code>${escapeHtml(device.addresses?.[0] || 'sin IP')}</code>
    </div>`).join('') : '<div class="empty"><strong>Sin interfaces compatibles</strong>No se encontraron conexiones Ethernet o Wi-Fi.</div>';

  const connections = devices.filter((device) => device.uuid);
  $('#networkConnection').innerHTML = connections.length
    ? connections.map((device) => `<option value="${escapeHtml(device.uuid)}">${escapeHtml(device.device)} · ${escapeHtml(device.connection)}</option>`).join('')
    : '<option value="">No hay conexiones activas</option>';
  $('#networkConnection').disabled = !connections.length;
  $('#ipv4Form').querySelector('button[type="submit"]').disabled = !connections.length;

  const wifiDevices = devices.filter((device) => device.type === 'wifi');
  $('#wifiForm').hidden = !wifiDevices.length;
  $('#wifiDevice').innerHTML = wifiDevices.map((device) => `<option value="${escapeHtml(device.device)}">${escapeHtml(device.device)}</option>`).join('');
  selectNetworkConnection();
}

async function openNetworkDialog() {
  $('#networkAdminKey').value = storedAdminKey();
  $('#networkError').textContent = '';
  $('#wifiError').textContent = '';
  $('#networkStatus').textContent = 'Consultando interfaces…';
  $('#networkDialog').showModal();
  try {
    state.network = await request('/api/network');
    renderNetwork();
  } catch (error) {
    $('#networkStatus').innerHTML = `<div class="empty"><strong>No fue posible consultar la red</strong>${escapeHtml(error.message)}</div>`;
  }
}

function render() {
  if (!state.data) return;
  renderSummary();
  renderPanels();
  renderLan();
  renderAreas();
  renderEvents();
  updateCountdown();
}

async function refresh() {
  try {
    state.data = await request('/api/state');
    render();
  } catch (error) {
    $('#liveState').classList.remove('online');
    $('#liveState').lastElementChild.textContent = 'Dashboard desconectado';
  }
}

function openPanelDialog(panel = null) {
  $('#panelDialogTitle').textContent = panel ? 'Editar panel' : 'Agregar panel';
  $('#panelId').value = panel?.id || '';
  $('#panelName').value = panel?.name || '';
  $('#panelHost').value = panel?.host || '';
  const source = panel?.source || 'total';
  $('#panelSource').value = source;
  $('#panelSource').dataset.previous = source;
  $('#panelPort').value = panel?.port || (bitmapSources.includes(source) ? 5001 : 5000);
  const defaultLeadingSpaces = Math.min(
    40,
    (state.data?.config.panels.filter((item) => !bitmapSources.includes(item.source)).length || 0)
      * (state.data?.defaultTextPanelLeadingSpaces ?? 2)
  );
  $('#panelMessageLeadingSpaces').value = panel
    ? panelMessageLeadingSpaces(panel)
    : defaultLeadingSpaces;
  $('#panelTemplate').value = panel?.template || '';
  $('#panelUnit').value = panel?.unit || 'auto';
  $('#panelDisplayMode').value = panel ? panelDisplayMode(panel) : 'both';
  $('#panelColorsEnabled').checked = panel?.colorsEnabled === true;
  $('#panelLabelColor').value = `#${panel?.labelColor || '00FF00'}`;
  $('#panelTimeColor').value = `#${panel?.timeColor || 'FF0000'}`;
  updateColorValues();
  $('#panelEnabled').checked = panel?.enabled !== false;
  updatePanelFormatFields();
  $('#panelError').textContent = '';
  $('#panelDialog').showModal();
  $('#panelName').focus();
}

function updatePanelFormatFields() {
  const source = $('#panelSource').value;
  const isTimed = timedSources.includes(source);
  const mode = $('#panelDisplayMode').value;
  $('#timeFormatFields').hidden = !isTimed;
  $('#unitField').hidden = isTimed && mode === 'label';
  $('#colorOptions').hidden = !isTimed;
  $('#colorFields').hidden = !isTimed || !$('#panelColorsEnabled').checked;
  $('#labelColorField').hidden = mode === 'time';
  $('#timeColorField').hidden = mode === 'label';
  $('#templateField').hidden = source !== 'custom';
  $('#bitmapField').hidden = !bitmapSources.includes(source);
  $('#messageLeadingSpacesField').hidden = bitmapSources.includes(source);
  if (bitmapSources.includes(source)) {
    $('#bitmapField').textContent = source === 'map_chile'
      ? 'Envía el mapa RGB565 de Chile 16×96 sin modificaciones al puerto UDP 5001 y espera la confirmación del panel.'
      : 'Envía el mapa RGB565 de Gran Santiago 96×96 al puerto UDP 5001 y espera la confirmación del panel.';
  }
}

function updateColorValues() {
  $('#panelLabelColorValue').value = $('#panelLabelColor').value.toUpperCase();
  $('#panelTimeColorValue').value = $('#panelTimeColor').value.toUpperCase();
}

$('#addPanelButton').addEventListener('click', () => openPanelDialog());
$('#panelSource').addEventListener('change', () => {
  const source = $('#panelSource').value;
  const previous = $('#panelSource').dataset.previous || 'total';
  const previousDefault = bitmapSources.includes(previous) ? 5001 : 5000;
  if (Number($('#panelPort').value) === previousDefault) {
    $('#panelPort').value = bitmapSources.includes(source) ? 5001 : 5000;
  }
  $('#panelSource').dataset.previous = source;
  updatePanelFormatFields();
});
$('#panelDisplayMode').addEventListener('change', updatePanelFormatFields);
$('#panelColorsEnabled').addEventListener('change', updatePanelFormatFields);
$('#panelLabelColor').addEventListener('input', updateColorValues);
$('#panelTimeColor').addEventListener('input', updateColorValues);
$('#networkButton').addEventListener('click', openNetworkDialog);
$('#printerText').addEventListener('input', updatePrinterForm);
$('#printerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!printSubmissionDisabled($('#printerText').value, state.printerSending)) {
    await submitPrinterText($('#printerText').value);
  }
});
$('#printerTestButton').addEventListener('click', async () => {
  await submitPrinterText(buildTestPrintText(new Date()));
});
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$$('.dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
}));

$('#panelForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#panelId').value;
  const payload = {
    name: $('#panelName').value, host: $('#panelHost').value,
    port: Number($('#panelPort').value), source: $('#panelSource').value,
    template: $('#panelTemplate').value, unit: $('#panelUnit').value,
    displayMode: $('#panelDisplayMode').value,
    colorsEnabled: $('#panelColorsEnabled').checked,
    labelColor: $('#panelLabelColor').value.slice(1),
    timeColor: $('#panelTimeColor').value.slice(1),
    messageLeadingSpaces: Number($('#panelMessageLeadingSpaces').value),
    enabled: $('#panelEnabled').checked
  };
  try {
    await request(id ? `/api/panels/${id}` : '/api/panels', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    $('#panelDialog').close();
    toast(id ? 'Ruta actualizada' : 'Panel agregado');
    await refresh();
  } catch (error) { $('#panelError').textContent = error.message; }
});

$('#testForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await request(`/api/panels/${$('#testPanelId').value}/test`, { method: 'POST', body: JSON.stringify({ message: $('#testMessage').value }) });
    $('#testDialog').close();
    toast('Datagrama enviado');
    await refresh();
  } catch (error) { $('#testError').textContent = error.message; }
});

$('#networkConnection').addEventListener('change', selectNetworkConnection);
$('#networkMethod').addEventListener('change', () => {
  $('#staticNetworkFields').hidden = $('#networkMethod').value !== 'manual';
});

$('#ipv4Form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorNode = $('#networkError');
  errorNode.textContent = '';
  const payload = {
    uuid: $('#networkConnection').value,
    method: $('#networkMethod').value,
    address: $('#networkAddress').value,
    gateway: $('#networkGateway').value,
    dns: $('#networkDns').value
  };
  try {
    const result = await request('/api/network/ipv4', {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify(payload)
    });
    toast(result.message);
    setTimeout(async () => {
      try {
        state.network = await request('/api/network');
        renderNetwork();
      } catch {}
    }, 2500);
  } catch (error) {
    errorNode.textContent = error.message === 'Failed to fetch'
      ? 'El cambio pudo aplicarse y cortar la conexión. Intenta abrir el dashboard en la nueva dirección.'
      : error.message;
  }
});

$('#wifiForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorNode = $('#wifiError');
  errorNode.textContent = '';
  try {
    const result = await request('/api/network/wifi', {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({
        device: $('#wifiDevice').value,
        ssid: $('#wifiSsid').value,
        password: $('#wifiPassword').value
      })
    });
    $('#wifiPassword').value = '';
    toast(result.message);
  } catch (error) {
    errorNode.textContent = error.message === 'Failed to fetch'
      ? 'La conexión cambió. Busca la nueva dirección de la Raspberry Pi.'
      : error.message;
  }
});

$('#panelList').addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  const row = event.target.closest('[data-panel-id]');
  if (!action || !row) return;
  const panel = state.data.config.panels.find((item) => item.id === row.dataset.panelId);
  if (!panel) return;
  if (action === 'edit') return openPanelDialog(panel);
  if (action === 'test') {
    if (bitmapSources.includes(panel.source)) {
      try {
        await request(`/api/panels/${panel.id}/test`, { method: 'POST', body: '{}' });
        toast('Mapa enviado y confirmado');
        await refresh();
      } catch (error) { toast(error.message); }
      return;
    }
    $('#testPanelId').value = panel.id;
    $('#testMessage').value = 'PRUEBA RNE';
    $('#testError').textContent = '';
    $('#testDialog').showModal();
    return;
  }
  if (action === 'delete' && confirm(`¿Eliminar la ruta “${panel.name}”?`)) {
    try {
      await request(`/api/panels/${panel.id}`, { method: 'DELETE' });
      toast('Ruta eliminada');
      await refresh();
    } catch (error) { toast(error.message); }
  }
});

$('#syncButton').addEventListener('click', async () => {
  const button = $('#syncButton');
  button.disabled = true;
  try {
    await request('/api/sync', { method: 'POST' });
    toast('Actualización iniciada');
    await refresh();
  } catch (error) { toast(error.message); }
  setTimeout(() => { button.disabled = false; }, 1000);
});

$('#scanLanButton').addEventListener('click', async () => {
  const button = $('#scanLanButton');
  button.disabled = true;
  try {
    await request('/api/lan/scan', { method: 'POST' });
    toast('Escaneo LAN iniciado');
    await refresh();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
});

$$('.filter').forEach((button) => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  $$('.filter').forEach((item) => item.classList.toggle('active', item === button));
  renderEvents();
}));

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const register = (tool) => {
    try {
      Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {});
    } catch {}
  };

  register({
    name: 'read_rne_dashboard_status',
    title: 'Read RNE dashboard status',
    description: 'Read the current RNE API health, total wait time, and configured LED panel routes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute() {
      if (!state.data) throw new Error('Dashboard state is not loaded yet.');
      return {
        apiStatus: state.data.health?.status || 'unknown',
        totalMinutes: state.data.results?.tiempo_total ?? null,
        lastPollAt: state.data.lastPollAt,
        detectedLanDevices: state.data.lan?.devices?.length || 0,
        panels: state.data.config.panels.map(({ id, name, host, port, source, unit, displayMode, colorsEnabled, labelColor, timeColor, messageLeadingSpaces, enabled }) => ({
          id, name, host, port, source, unit, displayMode, colorsEnabled, labelColor, timeColor, messageLeadingSpaces, enabled
        }))
      };
    }
  });

  register({
    name: 'sync_rne_panels_now',
    title: 'Sync RNE panels now',
    description: 'Start an immediate RNE API poll and send the refreshed values to every enabled LED panel route.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute() {
      const result = await request('/api/sync', { method: 'POST' });
      await refresh();
      return { accepted: result.ok, polling: true };
    }
  });

  register({
    name: 'send_led_panel_test',
    title: 'Send LED panel test',
    description: 'Send a UTF-8 test message, or resend the live map for a 96x96 bitmap panel.',
    inputSchema: {
      type: 'object',
      properties: {
        panelId: { type: 'string', description: 'ID returned by read_rne_dashboard_status.' },
        message: { type: 'string', minLength: 1, maxLength: 80, description: 'Required for text panels; ignored for bitmap panels.' }
      },
      required: ['panelId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!input || typeof input.panelId !== 'string') throw new Error('panelId is required.');
      const panel = state.data?.config.panels.find((item) => item.id === input.panelId);
      if (!panel) throw new Error('Panel route not found.');
      const isBitmap = bitmapSources.includes(panel.source);
      if (!isBitmap && (typeof input.message !== 'string' || !input.message.trim() || Array.from(input.message).length > 80)) {
        throw new Error('Text panels require a message of 1–80 characters.');
      }
      await request(`/api/panels/${encodeURIComponent(input.panelId)}/test`, {
        method: 'POST', body: JSON.stringify({ message: input.message || '' })
      });
      await refresh();
      return { sent: true, panelId: input.panelId, kind: isBitmap ? 'bitmap' : 'text', message: isBitmap ? null : input.message };
    }
  });
}

const stream = new EventSource('/api/events');
stream.addEventListener('update', refresh);
stream.addEventListener('connected', () => $('#liveState').lastElementChild.textContent = 'Conectado');
stream.onerror = () => $('#liveState').lastElementChild.textContent = 'Reconectando';

$('#printerAdminKey').value = storedAdminKey();
updatePrinterForm();
await refresh();
await refreshPrinterStatus();
registerWebMcpTools();
state.tick = setInterval(updateCountdown, 1000);

document.addEventListener('visibilitychange', () => {
  clearTimeout(state.printerTimer);
  if (!document.hidden) void refreshPrinterStatus();
});
window.addEventListener('pagehide', () => clearTimeout(state.printerTimer));
