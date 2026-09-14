const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = { data: null, network: null, filter: 'all', tick: null, toastTimer: null };
const sourceLabels = {
  total: 'Tiempo total', hospitalario: 'Hospitalario', tramites: 'Trámites',
  transporte: 'Transporte', vivienda: 'Vivienda', otro: 'Otro',
  latest_wait: 'Última espera', latest_testimony: 'Último testimonio', custom: 'Plantilla personalizada'
};
const categoryLabels = {
  hospitalario: 'Hospitalario', tramites: 'Trámites', transporte: 'Transporte',
  vivienda: 'Vivienda', otro: 'Otro'
};

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
    return `<article class="panel-row ${panel.enabled ? '' : 'disabled'}" data-panel-id="${escapeHtml(panel.id)}">
      ${ledIcon()}
      <div><p class="panel-name">${escapeHtml(panel.name)}</p><div class="panel-meta">${escapeHtml(panel.host)}:${panel.port}</div><div class="send-status"><i class="status-dot ${statusClass}"></i>${escapeHtml(statusText)}</div></div>
      <div class="route-source"><strong>${escapeHtml(sourceLabels[panel.source] || panel.source)}</strong>${escapeHtml(panel.template || 'Plantilla automática')}</div>
      <div class="panel-actions">
        <button class="small-action" data-action="test" title="Enviar prueba" aria-label="Probar ${escapeHtml(panel.name)}">Probar</button>
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

function renderEvents() {
  const events = state.data.events.filter((event) => state.filter === 'all' || event.kind === state.filter);
  const list = $('#activityList');
  if (!events.length) {
    list.innerHTML = '<div class="empty"><strong>Sin actividad todavía</strong>Las consultas y envíos aparecerán aquí.</div>';
    return;
  }
  list.innerHTML = events.slice(0, 100).map((event) => {
    const result = event.kind === 'udp' ? (event.ok ? 'SENT' : 'ERROR')
      : event.kind === 'api' ? (event.status || 'ERROR') : 'OK';
    const detailParts = [event.durationMs != null ? `${event.durationMs} ms` : '', event.bytes != null ? `${event.bytes} B` : '', event.message || event.error || ''].filter(Boolean);
    return `<article class="event ${event.kind}">
      <span class="event-method">${escapeHtml(event.method)}</span>
      <div><div class="event-target" title="${escapeHtml(event.target)}">${escapeHtml(event.panelName || event.target)}</div><div class="event-detail" title="${escapeHtml(detailParts.join(' · '))}">${escapeHtml(detailParts.join(' · '))}</div></div>
      <div class="event-result"><div class="event-code ${event.ok ? 'ok' : 'error'}">${escapeHtml(result)}</div><div class="event-time">${formatTime(event.at, true)}</div></div>
    </article>`;
  }).join('');
}

function adminHeaders() {
  const key = $('#networkAdminKey').value.trim();
  if (key) sessionStorage.setItem('rneNetworkAdminKey', key);
  return { 'x-rne-admin-token': key };
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
  $('#networkAdminKey').value = sessionStorage.getItem('rneNetworkAdminKey') || '';
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
  $('#panelPort').value = panel?.port || 5000;
  $('#panelSource').value = panel?.source || 'total';
  $('#panelTemplate').value = panel?.template || '';
  $('#panelEnabled').checked = panel?.enabled !== false;
  $('#panelError').textContent = '';
  $('#panelDialog').showModal();
  $('#panelName').focus();
}

$('#addPanelButton').addEventListener('click', () => openPanelDialog());
$('#networkButton').addEventListener('click', openNetworkDialog);
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
    template: $('#panelTemplate').value, enabled: $('#panelEnabled').checked
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
        panels: state.data.config.panels.map(({ id, name, host, port, source, enabled }) => ({ id, name, host, port, source, enabled }))
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
    description: 'Send one direct UTF-8 test message to a configured LED panel over UDP.',
    inputSchema: {
      type: 'object',
      properties: {
        panelId: { type: 'string', description: 'ID returned by read_rne_dashboard_status.' },
        message: { type: 'string', minLength: 1, maxLength: 80 }
      },
      required: ['panelId', 'message'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!input || typeof input.panelId !== 'string' || typeof input.message !== 'string' || !input.message.trim() || Array.from(input.message).length > 80) {
        throw new Error('panelId and a message of 1–80 characters are required.');
      }
      if (!state.data?.config.panels.some((panel) => panel.id === input.panelId)) throw new Error('Panel route not found.');
      await request(`/api/panels/${encodeURIComponent(input.panelId)}/test`, {
        method: 'POST', body: JSON.stringify({ message: input.message })
      });
      await refresh();
      return { sent: true, panelId: input.panelId, message: input.message };
    }
  });
}

const stream = new EventSource('/api/events');
stream.addEventListener('update', refresh);
stream.addEventListener('connected', () => $('#liveState').lastElementChild.textContent = 'Conectado');
stream.onerror = () => $('#liveState').lastElementChild.textContent = 'Reconectando';

await refresh();
registerWebMcpTools();
state.tick = setInterval(updateCountdown, 1000);
