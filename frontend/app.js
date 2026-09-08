requireSession();

const tenant = getTenant();
if (tenant) {
  document.querySelector('#tenantName').textContent = tenant.name;
}

document.querySelector('#logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

const STATUS_LABELS = {
  new: 'Nuevo',
  contacted: 'En conversación',
  follow_up: 'Recontacto',
  appointment: 'Cita',
  won: 'Cierre',
  not_interested: 'No le interesa'
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

async function loadDashboard() {
  try {
    const r = await authFetch('/api/dashboard');
    const d = await r.json();
    document.querySelector('#totalLeads').textContent = d.totalLeads;
    document.querySelector('#openLeads').textContent = d.openLeads;
  } catch {
    document.querySelector('#totalLeads').textContent = '—';
    document.querySelector('#openLeads').textContent = '—';
  }
}

async function loadChannelsStat() {
  try {
    const r = await authFetch('/api/channels');
    const channels = await r.json();
    const connected = channels.filter((c) => c.status === 'connected').length;
    document.querySelector('#connectedChannels').textContent = connected;
    document.querySelector('#totalChannels').textContent = channels.length;
  } catch {
    document.querySelector('#connectedChannels').textContent = '—';
    document.querySelector('#totalChannels').textContent = '—';
  }
}

async function loadPipelinePreview() {
  const container = document.querySelector('#pipelinePreview');
  try {
    const r = await authFetch('/api/leads');
    const leads = await r.json();

    container.innerHTML = Object.entries(STATUS_LABELS)
      .map(([key, label]) => {
        const count = leads.filter((l) => l.status === key).length;
        return `<div><h3>${label} <span>${count}</span></h3></div>`;
      })
      .join('');
  } catch {
    container.innerHTML = '<p class="muted" style="grid-column:1/-1">No se pudo cargar el pipeline.</p>';
  }
}

async function loadRecentConversations() {
  const container = document.querySelector('#recentConversations');
  try {
    const r = await authFetch('/api/conversations');
    const conversations = (await r.json()).slice(0, 5);

    if (conversations.length === 0) {
      container.innerHTML = '<p class="muted">Aún no hay conversaciones.</p>';
      return;
    }

    container.innerHTML = conversations
      .map(
        (c) => `
        <div class="conversation">
          <b>${escapeHtml(c.lead_name || c.lead_phone || 'Sin nombre')}</b>
          <span>${escapeHtml(c.channel_type || '')}</span>
          <p>${escapeHtml(c.last_message_body || 'Sin mensajes todavía')}</p>
        </div>`
      )
      .join('');
  } catch {
    container.innerHTML = '<p class="muted">No se pudieron cargar las conversaciones.</p>';
  }
}

document.querySelector('#newLeadBtn').addEventListener('click', async () => {
  const phone = prompt('Número de teléfono del lead (con código de país, solo dígitos):');
  if (!phone) return;
  const name = prompt('Nombre (opcional):') || undefined;

  try {
    const r = await authFetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, name })
    });
    const data = await r.json();
    if (!r.ok) {
      alert(data.error || 'No se pudo crear el lead.');
      return;
    }
    alert('Lead creado correctamente.');
    loadDashboard();
    loadPipelinePreview();
  } catch {
    alert('Error de conexión al crear el lead.');
  }
});

loadDashboard();
loadChannelsStat();
loadPipelinePreview();
loadRecentConversations();
