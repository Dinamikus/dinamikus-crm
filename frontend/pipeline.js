requireSession();

const tenant = getTenant();
if (tenant) document.querySelector('#tenantName').textContent = tenant.name;

const currentUser = JSON.parse(localStorage.getItem('dinamikus_user') || 'null');
const role = currentUser ? currentUser.role : 'agent';

document.querySelector('#logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

const COLUMNS = [
  { key: 'new', label: 'Nuevo' },
  { key: 'contacted', label: 'En conversación' },
  { key: 'follow_up', label: 'Recontacto' },
  { key: 'appointment', label: 'Cita' },
  { key: 'won', label: 'Cierre' },
  { key: 'not_interested', label: 'No le interesa' }
];

if (role === 'supervisor') {
  document.querySelector('#pipelineHint').textContent =
    'Como supervisor puedes ver el pipeline completo, pero solo un admin o el propio asesor pueden mover un lead de etapa.';
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

let draggedLeadId = null;

async function loadPipeline() {
  const container = document.querySelector('#kanban');
  try {
    const r = await authFetch('/api/leads');
    const leads = await r.json();

    container.innerHTML = COLUMNS.map((col) => {
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
          <h3>${col.label} <span>${items.length}</span></h3>
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

loadPipeline();
