requireSession();

const tenant = getTenant();
if (tenant) {
  document.querySelector('#tenantName').textContent = tenant.name;
}

document.querySelector('#logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

async function loadDashboard() {
  try {
    const r = await authFetch('/api/dashboard');
    const d = await r.json();
    document.querySelector('#totalLeads').textContent = d.totalLeads;
    document.querySelector('#openLeads').textContent = d.openLeads;
  } catch (e) {
    document.querySelector('#totalLeads').textContent = '—';
    document.querySelector('#openLeads').textContent = '—';
  }
}
loadDashboard();
