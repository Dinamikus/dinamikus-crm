requireSession();

const tenant = getTenant();
if (tenant) document.querySelector('#tenantName').textContent = tenant.name;

const currentUser = JSON.parse(localStorage.getItem('dinamikus_user') || 'null');
const isAdmin = currentUser && currentUser.role === 'admin';
const isSupervisor = currentUser && currentUser.role === 'supervisor';
const canView = isAdmin || isSupervisor;

document.querySelector('#logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

if (!canView) {
  document.querySelector('#onlyAdminNotice').style.display = 'block';
  document.querySelector('#reportContent').style.display = 'none';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Las columnas de etapa son las de ESTE negocio (personalizables) — se arma el
// encabezado de la tabla dinámicamente según lo que responda la API.
function renderHeader(stages) {
  const headerRow = document.querySelector('#reportHeaderRow');
  const fixedHeaders = '<th>Asesor</th><th>Recibidos</th><th>En conversación</th><th>Sin respuesta</th>';
  const stageHeaders = stages.map((s) => `<th>${escapeHtml(s.label)}</th>`).join('');
  headerRow.innerHTML = fixedHeaders + stageHeaders;
}

function renderRow(name, row, stages, extraClass) {
  const stageCells = stages.map((s) => `<td>${row.by_stage[s.key] || 0}</td>`).join('');
  return `
    <tr class="${extraClass || ''}">
      <td>${escapeHtml(name)}</td>
      <td>${row.recibidos}</td>
      <td>${row.en_conversacion}</td>
      <td>${row.sin_respuesta}</td>
      ${stageCells}
    </tr>`;
}

async function loadReport() {
  const from = document.querySelector('#fromDate').value;
  const to = document.querySelector('#toDate').value;
  const status = document.querySelector('#reportStatus');
  const tbody = document.querySelector('#reportBody');

  if (!from || !to) {
    status.textContent = 'Elige ambas fechas.';
    return;
  }

  status.textContent = 'Cargando…';
  try {
    const r = await authFetch(`/api/reports/advisors?from=${from}&to=${to}`);
    const data = await r.json();
    if (!r.ok) {
      status.textContent = data.error || 'No se pudo cargar el reporte.';
      return;
    }
    status.textContent = '';

    const stages = data.stages || [];
    renderHeader(stages);
    const colspan = 4 + stages.length;

    if (data.advisors.length === 0 && Number(data.unassigned.recibidos) === 0) {
      tbody.innerHTML = `<tr><td colspan="${colspan}" class="muted">No hay leads en ese rango de fechas.</td></tr>`;
      return;
    }

    const totals = { recibidos: 0, en_conversacion: 0, sin_respuesta: 0, by_stage: {} };
    stages.forEach((s) => { totals.by_stage[s.key] = 0; });
    let rowsHtml = '';

    data.advisors.forEach((a) => {
      totals.recibidos += Number(a.recibidos);
      totals.en_conversacion += Number(a.en_conversacion);
      totals.sin_respuesta += Number(a.sin_respuesta);
      stages.forEach((s) => { totals.by_stage[s.key] += Number(a.by_stage[s.key] || 0); });
      const label = a.is_active ? a.advisor_name : `${a.advisor_name} (inactivo)`;
      rowsHtml += renderRow(label, a, stages, a.is_active ? '' : 'inactive-row');
    });

    if (Number(data.unassigned.recibidos) > 0) {
      totals.recibidos += Number(data.unassigned.recibidos);
      totals.en_conversacion += Number(data.unassigned.en_conversacion);
      totals.sin_respuesta += Number(data.unassigned.sin_respuesta);
      stages.forEach((s) => { totals.by_stage[s.key] += Number(data.unassigned.by_stage[s.key] || 0); });
      rowsHtml += renderRow('Sin asignar', data.unassigned, stages);
    }

    rowsHtml += renderRow('Total', totals, stages, 'totals-row');
    tbody.innerHTML = rowsHtml;
  } catch {
    status.textContent = 'Error de conexión al cargar el reporte.';
  }
}

if (canView) {
  document.querySelector('#fromDate').value = daysAgoISO(9); // últimos 10 días por defecto
  document.querySelector('#toDate').value = todayISO();
  document.querySelector('#loadReportBtn').addEventListener('click', loadReport);
  loadReport();
}
