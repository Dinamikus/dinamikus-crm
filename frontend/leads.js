requireSession();

const tenant = getTenant();
if (tenant) document.querySelector('#tenantName').textContent = tenant.name;

const currentUser = JSON.parse(localStorage.getItem('dinamikus_user') || 'null');
const isAdmin = currentUser && currentUser.role === 'admin';
if (!isAdmin) {
  document.querySelector('#exportBtn').style.display = 'none';
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

let allLeads = [];
let parsedImportRows = [];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function renderTable(leads) {
  const body = document.querySelector('#leadsBody');
  if (leads.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="muted">No hay leads que coincidan.</td></tr>';
    return;
  }
  body.innerHTML = leads
    .map(
      (l) => `
      <tr>
        <td>${escapeHtml(l.phone || '—')}</td>
        <td>${escapeHtml(l.name || '—')}</td>
        <td>${escapeHtml(l.source || '—')}</td>
        <td>${escapeHtml(STATUS_LABELS[l.status] || l.status)}</td>
        <td>${escapeHtml(l.assigned_user_name || 'Sin asignar')}</td>
        <td>${new Date(l.created_at).toLocaleDateString('es-SV')}</td>
      </tr>`
    )
    .join('');
}

function applyFilter() {
  const q = document.querySelector('#searchBox').value.trim().toLowerCase();
  if (!q) return renderTable(allLeads);
  const filtered = allLeads.filter(
    (l) => (l.phone && l.phone.includes(q)) || (l.name && l.name.toLowerCase().includes(q))
  );
  renderTable(filtered);
}

async function loadLeads() {
  try {
    const r = await authFetch('/api/leads');
    allLeads = await r.json();
    renderTable(allLeads);
  } catch {
    document.querySelector('#leadsBody').innerHTML =
      '<tr><td colspan="6" class="muted">No se pudieron cargar los leads.</td></tr>';
  }
}

function toCsvValue(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

document.querySelector('#exportBtn').addEventListener('click', () => {
  const q = document.querySelector('#searchBox').value.trim().toLowerCase();
  const rows = q
    ? allLeads.filter((l) => (l.phone && l.phone.includes(q)) || (l.name && l.name.toLowerCase().includes(q)))
    : allLeads;

  const header = ['telefono', 'nombre', 'origen', 'estado', 'asignado_a', 'llego'];
  const lines = [header.join(',')];
  rows.forEach((l) => {
    lines.push(
      [
        toCsvValue(l.phone),
        toCsvValue(l.name),
        toCsvValue(l.source),
        toCsvValue(STATUS_LABELS[l.status] || l.status),
        toCsvValue(l.assigned_user_name || ''),
        toCsvValue(new Date(l.created_at).toLocaleDateString('es-SV'))
      ].join(',')
    );
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

document.querySelector('#searchBox').addEventListener('input', applyFilter);

// --- Importación (solo admin) ---
function findPhoneColumn(headers) {
  const idx = headers.findIndex((h) => /tel|phone|numero|número|celular|whatsapp/i.test(h));
  return idx >= 0 ? idx : 0;
}
function findNameColumn(headers) {
  return headers.findIndex((h) => /nombre|name/i.test(h));
}

async function initImport() {
  if (!isAdmin) return;
  document.querySelector('#importCard').style.display = 'block';

  try {
    const r = await authFetch('/api/users?active=true');
    const users = await r.json();
    const select = document.querySelector('#importAssignee');
    users.forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name;
      select.appendChild(opt);
    });
  } catch {
    /* el selector queda solo con "Sin asignar" */
  }

  const fileInput = document.querySelector('#importFile');
  const preview = document.querySelector('#importPreview');
  const importBtn = document.querySelector('#importBtn');

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    parsedImportRows = [];
    importBtn.disabled = true;
    preview.textContent = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const workbook = XLSX.read(e.target.result, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        if (rows.length === 0) {
          preview.textContent = 'El archivo está vacío.';
          return;
        }

        const headers = rows[0].map((h) => String(h));
        const phoneCol = findPhoneColumn(headers);
        const nameCol = findNameColumn(headers);

        parsedImportRows = rows
          .slice(1)
          .map((row) => ({
            phone: String(row[phoneCol] ?? '').trim(),
            name: nameCol >= 0 ? String(row[nameCol] ?? '').trim() : ''
          }))
          .filter((r) => r.phone);

        preview.textContent = `${parsedImportRows.length} números detectados (columna "${headers[phoneCol]}").`;
        importBtn.disabled = parsedImportRows.length === 0;
      } catch {
        preview.textContent = 'No se pudo leer el archivo. Confirma que sea .csv, .xlsx o .xls.';
      }
    };
    reader.readAsArrayBuffer(file);
  });

  importBtn.addEventListener('click', async () => {
    const errorBox = document.querySelector('#importError');
    const resultBox = document.querySelector('#importResult');
    errorBox.classList.remove('visible');
    resultBox.classList.remove('visible');
    importBtn.disabled = true;
    importBtn.textContent = 'Importando…';

    try {
      const r = await authFetch('/api/leads/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leads: parsedImportRows,
          source: document.querySelector('#importSource').value.trim() || 'import',
          assignedUserId: document.querySelector('#importAssignee').value || null
        })
      });
      const data = await r.json();
      if (!r.ok) {
        errorBox.textContent = data.error || 'No se pudo importar.';
        errorBox.classList.add('visible');
        return;
      }
      resultBox.textContent = `Listo: ${data.imported} números nuevos importados, ${data.skippedDuplicate} ya existían, ${data.skippedInvalid} no eran números válidos.`;
      resultBox.classList.add('visible');
      document.querySelector('#importFile').value = '';
      parsedImportRows = [];
      document.querySelector('#importPreview').textContent = '';
      loadLeads();
    } catch {
      errorBox.textContent = 'Error de conexión al importar.';
      errorBox.classList.add('visible');
    } finally {
      importBtn.disabled = true;
      importBtn.textContent = 'Importar';
    }
  });
}

loadLeads();
initImport();
