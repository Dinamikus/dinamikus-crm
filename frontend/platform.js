requireSession();

const tenant = getTenant();
if (tenant) document.querySelector('#tenantName').textContent = tenant.name;

const currentUser = JSON.parse(localStorage.getItem('dinamikus_user') || 'null');

document.querySelector('#logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

if (!currentUser || !currentUser.isPlatformAdmin) {
  document.querySelector('#notPlatformAdminNotice').style.display = 'block';
  document.querySelector('#tenantsCard').style.display = 'none';
} else {
  document.querySelector('#createTenantCard').style.display = 'block';
  loadTenants();
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let pass = '';
  const values = new Uint32Array(12);
  crypto.getRandomValues(values);
  for (let i = 0; i < 12; i++) pass += chars[values[i] % chars.length];
  return pass;
}

const genBtn = document.querySelector('#genTenantPasswordBtn');
if (genBtn) {
  genBtn.addEventListener('click', () => {
    document.querySelector('#newTenantPassword').value = generatePassword();
  });
}

const createTenantForm = document.querySelector('#createTenantForm');
if (createTenantForm) {
  createTenantForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.querySelector('#createTenantError');
    const successBox = document.querySelector('#createTenantSuccess');
    errorBox.classList.remove('visible');
    successBox.classList.remove('visible');

    const form = new FormData(e.target);
    const body = {
      businessName: form.get('businessName'),
      adminName: form.get('adminName'),
      email: form.get('email'),
      password: form.get('password')
    };

    try {
      const r = await authFetch('/api/platform/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok) {
        errorBox.textContent = data.error || 'No se pudo crear el negocio.';
        errorBox.classList.add('visible');
        return;
      }
      successBox.textContent = `Negocio "${data.tenant.name}" creado. Entrégale a ${data.admin.name}: correo ${data.admin.email}, y la contraseña que generaste arriba.`;
      successBox.classList.add('visible');
      e.target.reset();
      loadTenants();
    } catch {
      errorBox.textContent = 'Error de conexión al crear el negocio.';
      errorBox.classList.add('visible');
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

async function loadTenants() {
  const body = document.querySelector('#tenantsBody');
  try {
    const r = await authFetch('/api/platform/tenants');
    if (!r.ok) {
      body.innerHTML = '<tr><td colspan="7" class="muted">No se pudo cargar (¿tienes permiso de plataforma?).</td></tr>';
      return;
    }
    const tenants = await r.json();

    if (tenants.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="muted">Aún no hay negocios registrados.</td></tr>';
      return;
    }

    body.innerHTML = tenants
      .map((t) => {
        const isSelf = t.id === (tenant && tenant.id);
        const badge = t.is_active
          ? '<span class="badge connected">Activo</span>'
          : '<span class="badge pending">Pausado</span>';
        const toggleBtn = isSelf
          ? '<span class="muted" style="font-size:12px">(tu propio negocio)</span>'
          : `<button class="remove-btn toggle-tenant-btn" data-id="${t.id}" data-active="${t.is_active}" data-name="${escapeHtml(t.name)}" style="color:${t.is_active ? '#b42318' : '#027a48'}">${t.is_active ? 'Pausar' : 'Reactivar'}</button>`;
        return `
          <tr>
            <td>${escapeHtml(t.name)}</td>
            <td>${escapeHtml(t.admin_email || '—')}</td>
            <td>${t.user_count}</td>
            <td>${new Date(t.created_at).toLocaleDateString('es-SV')}</td>
            <td>${t.last_lead_at ? new Date(t.last_lead_at).toLocaleDateString('es-SV') : '—'}</td>
            <td>${badge}</td>
            <td>${toggleBtn}</td>
          </tr>`;
      })
      .join('');

    document.querySelectorAll('.toggle-tenant-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const active = btn.dataset.active === 'true';
        const msg = active
          ? `¿Pausar a "${btn.dataset.name}"? Todos sus usuarios perderán acceso de inmediato — nada se borra, pueden reactivarlo cuando quieras.`
          : `¿Reactivar a "${btn.dataset.name}"?`;
        if (!confirm(msg)) return;

        await authFetch(`/api/platform/tenants/${btn.dataset.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !active })
        });
        loadTenants();
      });
    });
  } catch {
    body.innerHTML = '<tr><td colspan="7" class="muted">Error de conexión.</td></tr>';
  }
}
