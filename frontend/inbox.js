requireSession();

const tenant = getTenant();
if (tenant) document.querySelector('#tenantName').textContent = tenant.name;

const currentUser = JSON.parse(localStorage.getItem('dinamikus_user') || 'null');
const isAdmin = currentUser && currentUser.role === 'admin';
const isSupervisor = currentUser && currentUser.role === 'supervisor';
const canReassign = isAdmin || isSupervisor; // admin y supervisor reparten leads entre asesores
const canOperateLeads = isAdmin || currentUser?.role === 'agent'; // cambiar estado/responder

if (!canReassign) {
  document.querySelector('#filterAssignee').style.display = 'none';
}
if (!isAdmin) {
  document.querySelector('.auto-assign-toggle').style.display = 'none'; // configuración del sistema: solo admin
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

let conversations = [];
let channels = [];
let users = [];
let activeConversationId = null;
let refreshTimer = null;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function currentFilters() {
  const channelId = document.querySelector('#filterChannel').value;
  const assignee = document.querySelector('#filterAssignee').value;
  const params = new URLSearchParams();
  if (channelId) params.set('channelId', channelId);
  if (assignee === '__unassigned__') params.set('unassigned', 'true');
  else if (assignee) params.set('assignedUserId', assignee);
  return params.toString();
}

async function loadFilterOptions() {
  try {
    const [channelsRes, usersRes] = await Promise.all([
      authFetch('/api/channels'),
      authFetch('/api/users?active=true')
    ]);
    channels = await channelsRes.json();
    users = await usersRes.json();

    const channelSelect = document.querySelector('#filterChannel');
    channels.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.type} · ${c.display_name || c.external_id || ''}`;
      channelSelect.appendChild(opt);
    });

    const assigneeSelect = document.querySelector('#filterAssignee');
    users.forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name;
      assigneeSelect.appendChild(opt);
    });

    channelSelect.addEventListener('change', () => loadConversations());
    if (canReassign) assigneeSelect.addEventListener('change', () => loadConversations());
  } catch {
    /* si falla, los filtros simplemente quedan solo con "Todos" */
  }
}

async function loadAutoAssignSetting() {
  const toggle = document.querySelector('#autoAssignToggle');
  try {
    const r = await authFetch('/api/tenant/settings');
    const settings = await r.json();
    toggle.checked = !!settings.auto_assign_leads;
  } catch {
    /* deja el toggle en su estado por defecto si falla */
  }

  toggle.addEventListener('change', async () => {
    try {
      await authFetch('/api/tenant/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoAssignLeads: toggle.checked })
      });
    } catch {
      toggle.checked = !toggle.checked; // revertir si falló
    }
  });
}

async function loadConversations() {
  const container = document.querySelector('#convoItems');
  try {
    const qs = currentFilters();
    const r = await authFetch(`/api/conversations${qs ? `?${qs}` : ''}`);
    conversations = await r.json();

    if (conversations.length === 0) {
      container.innerHTML = '<div class="empty-state">No hay conversaciones con estos filtros.</div>';
      return;
    }

    container.innerHTML = conversations
      .map((c) => {
        const preview = c.last_message_body
          ? `<p class="preview ${c.last_message_direction}">${escapeHtml(c.last_message_body)}</p>`
          : '<p class="preview">Sin mensajes todavía</p>';
        const assignee = c.assigned_user_name
          ? `<span class="assignee-tag">${escapeHtml(c.assigned_user_name)}</span>`
          : '<span class="assignee-tag" style="color:#98a2b3">Sin asignar</span>';
        return `
          <button class="convo-item ${c.id === activeConversationId ? 'active' : ''}" data-id="${c.id}">
            <div class="row">
              <span class="name">${escapeHtml(c.lead_name || c.lead_phone || 'Sin nombre')}</span>
              <span class="channel">${escapeHtml(c.channel_type || '')}</span>
            </div>
            ${preview}
            ${assignee}
          </button>`;
      })
      .join('');

    container.querySelectorAll('.convo-item').forEach((btn) => {
      btn.addEventListener('click', () => openConversation(btn.dataset.id));
    });

    if (activeConversationId && !conversations.some((c) => c.id === activeConversationId)) {
      activeConversationId = null;
    }
  } catch (e) {
    container.innerHTML = '<div class="empty-state">No se pudieron cargar las conversaciones.</div>';
  }
}

async function openConversation(id) {
  activeConversationId = id;
  document.querySelectorAll('.convo-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.id === id);
  });
  await renderThread(id);
}

async function renderThread(id) {
  const thread = document.querySelector('#thread');
  try {
    const r = await authFetch(`/api/conversations/${id}/messages`);
    const data = await r.json();
    const { conversation, messages } = data;

    const statusOptions = Object.entries(STATUS_LABELS)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join('');
    const assigneeControl = canReassign
      ? `<select id="leadAssignee"><option value="">Sin asignar</option>${users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('')}</select>`
      : '';

    const messagesHtml = messages
      .map(
        (m) => `
        <div class="bubble ${m.direction}">
          ${escapeHtml(m.body || `[${m.message_type}]`)}
          <time>${new Date(m.created_at).toLocaleString('es-SV', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}</time>
        </div>`
      )
      .join('');

    thread.innerHTML = `
      <div class="thread-head">
        <div>
          <h2>${escapeHtml(conversation.lead_name || conversation.lead_phone || 'Sin nombre')}</h2>
          <p>${escapeHtml(conversation.lead_phone || '')}</p>
        </div>
        <div style="display:flex;gap:8px">
          ${assigneeControl}
          <select id="leadStatus" ${isSupervisor ? 'disabled title="Un supervisor no puede cambiar el estado del lead"' : ''}>${statusOptions}</select>
        </div>
      </div>
      <div class="thread-messages" id="threadMessages">${messagesHtml || '<div class="empty-state">Sin mensajes todavía</div>'}</div>
      ${
        isSupervisor
          ? '<p class="muted" style="padding:14px 16px;border-top:1px solid #edf0f5;margin:0">Como supervisor puedes ver la conversación y reasignar el lead, pero no responder mensajes.</p>'
          : `<form class="thread-reply" id="replyForm">
        <textarea id="replyText" placeholder="Escribe una respuesta…" required></textarea>
        <button type="submit">Enviar</button>
      </form>`
      }
    `;

    const threadMessages = document.querySelector('#threadMessages');
    threadMessages.scrollTop = threadMessages.scrollHeight;

    const convoMeta = conversations.find((c) => c.id === id);
    const statusSelect = document.querySelector('#leadStatus');
    if (convoMeta) statusSelect.value = convoMeta.lead_status || 'new';
    statusSelect.addEventListener('change', async () => {
      try {
        await authFetch(`/api/leads/${conversation.lead_id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: statusSelect.value })
        });
      } catch {
        /* silently ignore — the select still reflects the attempted value */
      }
    });

    const assigneeSelect = document.querySelector('#leadAssignee');
    if (assigneeSelect) {
      assigneeSelect.value = conversation.assigned_user_id || '';
      assigneeSelect.addEventListener('change', async () => {
        try {
          await authFetch(`/api/leads/${conversation.lead_id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assignedUserId: assigneeSelect.value || null })
          });
          await loadConversations();
        } catch {
          /* silently ignore */
        }
      });
    }

    const replyForm = document.querySelector('#replyForm');
    if (replyForm) {
      replyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const textarea = document.querySelector('#replyText');
        const button = e.target.querySelector('button');
        const body = textarea.value.trim();
        if (!body) return;

        button.disabled = true;
        try {
          const r = await authFetch('/api/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ leadId: conversation.lead_id, body })
          });
          if (!r.ok) {
            const err = await r.json();
            alert(err.error || 'No se pudo enviar el mensaje');
            return;
          }
          textarea.value = '';
          await renderThread(id);
          await loadConversations();
        } finally {
          button.disabled = false;
        }
      });
    }
  } catch (e) {
    thread.innerHTML = '<div class="empty-state" style="margin:auto">No se pudo cargar la conversación.</div>';
  }
}

async function init() {
  await loadFilterOptions();
  await loadAutoAssignSetting();
  await loadConversations();
  // Refresco periódico para reflejar mensajes entrantes nuevos sin recargar la página.
  refreshTimer = setInterval(() => loadConversations(), 15000);
  window.addEventListener('beforeunload', () => clearInterval(refreshTimer));
}

init();
