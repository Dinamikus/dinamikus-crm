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

function renderRow(name, row, extraClass) {
  return `
    <tr class="${extraClass || ''}">
      <td>${escapeHtml(name)}</td>
      <td>${row.recibidos}</td>
      <td>${row.en_conversacion}</td>
      <td>${row.sin_respuesta}</td>
      <td>${row.recontacto}</td>
      <td>${row.citas}</td>
      <td>${row.cierres}</td>
      <td>${row.no_le_interesa}</td>
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

    if (data.advisors.length === 0 && Number(data.unassigned.recibidos) === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">No hay leads en ese rango de fechas.</td></tr>';
      return;
    }

    const totals = { recibidos: 0, en_conversacion: 0, sin_respuesta: 0, recontacto: 0, citas: 0, cierres: 0, no_le_interesa: 0 };
    let rowsHtml = '';

    data.advisors.forEach((a) => {
      Object.keys(totals).forEach((k) => { totals[k] += Number(a[k]); });
      const label = a.is_active ? a.advisor_name : `${a.advisor_name} (inactivo)`;
      rowsHtml += renderRow(label, a, a.is_active ? '' : 'inactive-row');
    });

    if (Number(data.unassigned.recibidos) > 0) {
      Object.keys(totals).forEach((k) => { totals[k] += Number(data.unassigned[k]); });
      rowsHtml += renderRow('Sin asignar', data.unassigned);
    }

    rowsHtml += renderRow('Total', totals, 'totals-row');
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
