requireSession();

const tenant = getTenant();
if (tenant) document.querySelector('#tenantName').textContent = tenant.name;

const currentUser = JSON.parse(localStorage.getItem('dinamikus_user') || 'null');
const role = currentUser ? currentUser.role : 'agent';
const isAdmin = role === 'admin';

document.querySelector('#logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

if (role === 'supervisor') {
  document.querySelector('#pipelineHint').textContent =
    'Como supervisor puedes ver el pipeline completo, pero solo un admin o el propio asesor pueden mover un lead de etapa.';
}
if (isAdmin) {
  document.querySelector('#manageStagesBtn').style.display = 'inline-block';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function canDrag(lead) {
  if (role === 'supervisor') return false;
  if (role === 'admin') return true;
  return lead.assigned_user_id === (currentUser && currentUser.id); // agent: solo lo suyo
}

let stagesCache = [];
let draggedLeadId = null;

async function loadStages() {
  const r = await authFetch('/api/pipeline-stages');
  stagesCache = await r.json();
  return stagesCache;
}

async function loadPipeline() {
  const container = document.querySelector('#kanban');
  try {
    const stages = await loadStages();
    const r = await authFetch('/api/leads');
    const leads = await r.json();

    container.innerHTML = stages.map((col) => {
      const items = leads.filter((l) => l.status === col.key);
      const cardsHtml = items.length
        ? items
            .map(
              (l) => `
              <div class="kanban-card" draggable="${canDrag(l)}" data-id="${l.id}">
                ${escapeHtml(l.phone || l.name || 'Sin nombre')}
                <small>${escapeHtml(l.name || '')}${l.name ? ' · ' : ''}${escapeHtml(l.assigned_user_name || 'Sin asignar')}</small>
              </div>`
            )
            .join('')
        : '<div class="kanban-empty">Vacío</div>';

      return `
        <div class="kanban-col" data-status="${col.key}">
          <h3>${escapeHtml(col.label)} <span>${items.length}</span></h3>
          <div class="kanban-cards">${cardsHtml}</div>
        </div>`;
    }).join('');

    wireDragAndDrop();
  } catch {
    container.innerHTML = '<p class="muted">No se pudo cargar el pipeline.</p>';
  }
}

function wireDragAndDrop() {
  document.querySelectorAll('.kanban-card[draggable="true"]').forEach((card) => {
    card.addEventListener('dragstart', () => {
      draggedLeadId = card.dataset.id;
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedLeadId = null;
    });
  });

  document.querySelectorAll('.kanban-col').forEach((col) => {
    col.addEventListener('dragover', (e) => {
      if (!draggedLeadId) return;
      e.preventDefault();
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      if (!draggedLeadId) return;

      const newStatus = col.dataset.status;
      const leadId = draggedLeadId;
      draggedLeadId = null;

      try {
        const r = await authFetch(`/api/leads/${leadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus })
        });
        if (!r.ok) {
          const data = await r.json();
          alert(data.error || 'No se pudo mover el lead.');
        }
      } catch {
        alert('Error de conexión al mover el lead.');
      } finally {
        loadPipeline();
      }
    });
  });
}

// --- Gestión de etapas (solo admin) ---
function renderStagesManager() {
  const list = document.querySelector('#stagesList');
  list.innerHTML = stagesCache
    .map(
      (s, i) => `
      <div class="channel-row">
        <div class="meta">
          <strong>${escapeHtml(s.label)}</strong>
          <span>${s.is_default ? 'Etapa inicial · ' : ''}${s.is_closed ? 'Etapa de cierre' : 'Etapa activa'}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <button class="remove-btn move-up-btn" data-id="${s.id}" ${i === 0 ? 'disabled' : ''} style="color:#475467">↑</button>
          <button class="remove-btn move-down-btn" data-id="${s.id}" ${i === stagesCache.length - 1 ? 'disabled' : ''} style="color:#475467">↓</button>
          <button class="remove-btn rename-btn" data-id="${s.id}" data-label="${escapeHtml(s.label)}" style="color:#2563eb">Renombrar</button>
          <label style="font-size:12px;display:flex;align-items:center;gap:4px">
            <input type="checkbox" class="closed-toggle" data-id="${s.id}" ${s.is_closed ? 'checked' : ''}> Cierre
          </label>
          <label style="font-size:12px;display:flex;align-items:center;gap:4px">
            <input type="radio" name="defaultStage" class="default-toggle" data-id="${s.id}" ${s.is_default ? 'checked' : ''}> Inicial
          </label>
          <button class="remove-btn delete-stage-btn" data-id="${s.id}" data-label="${escapeHtml(s.label)}">Borrar</button>
        </div>
      </div>`
    )
    .join('');

  list.querySelectorAll('.move-up-btn, .move-down-btn').forEach((btn) => {
    btn.addEventListener('click', () => patchStage(btn.dataset.id, { move: btn.classList.contains('move-up-btn') ? 'up' : 'down' }));
  });
  list.querySelectorAll('.closed-toggle').forEach((el) => {
    el.addEventListener('change', () => patchStage(el.dataset.id, { isClosed: el.checked }));
  });
  list.querySelectorAll('.default-toggle').forEach((el) => {
    el.addEventListener('change', () => patchStage(el.dataset.id, { isDefault: true }));
  });
  list.querySelectorAll('.rename-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const newLabel = prompt('Nuevo nombre de la etapa:', btn.dataset.label);
      if (newLabel && newLabel.trim()) patchStage(btn.dataset.id, { label: newLabel.trim() });
    });
  });
  list.querySelectorAll('.delete-stage-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`¿Borrar la etapa "${btn.dataset.label}"? Solo se puede si no tiene leads adentro.`)) return;
      const r = await authFetch(`/api/pipeline-stages/${btn.dataset.id}`, { method: 'DELETE' });
      if (!r.ok) {
        const data = await r.json();
        alert(data.error || 'No se pudo borrar la etapa.');
        return;
      }
      await loadStages();
      renderStagesManager();
      loadPipeline();
    });
  });
}

async function patchStage(id, body) {
  const errorBox = document.querySelector('#stageError');
  errorBox.classList.remove('visible');
  const r = await authFetch(`/api/pipeline-stages/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const data = await r.json();
    errorBox.textContent = data.error || 'No se pudo actualizar la etapa.';
    errorBox.classList.add('visible');
    return;
  }
  await loadStages();
  renderStagesManager();
  loadPipeline();
}

if (isAdmin) {
  document.querySelector('#manageStagesBtn').addEventListener('click', () => {
    const card = document.querySelector('#stagesCard');
    const opening = card.style.display === 'none';
    card.style.display = opening ? 'block' : 'none';
    if (opening) renderStagesManager();
  });

  document.querySelector('#createStageForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.querySelector('#stageError');
    errorBox.classList.remove('visible');
    const form = new FormData(e.target);

    const r = await authFetch('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: form.get('label') })
    });
    if (!r.ok) {
      const data = await r.json();
      errorBox.textContent = data.error || 'No se pudo crear la etapa.';
      errorBox.classList.add('visible');
      return;
    }
    e.target.reset();
    await loadStages();
    renderStagesManager();
    loadPipeline();
  });
}

loadPipeline();
