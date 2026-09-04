requireSession();

const tenant = getTenant();
const currentUser = JSON.parse(localStorage.getItem('dinamikus_user') || 'null');
if (tenant) document.querySelector('#tenantName').textContent = tenant.name;

document.querySelector('#logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

const isAdmin = currentUser && currentUser.role === 'admin';
if (!isAdmin) {
  document.querySelector('#onlyAdminNotice').style.display = 'block';
  document.querySelector('#createCard').style.display = 'none';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let pass = '';
  const values = new Uint32Array(12);
  crypto.getRandomValues(values);
  for (let i = 0; i < 12; i++) pass += chars[values[i] % chars.length];
  return pass;
}

document.querySelector('#genPasswordBtn').addEventListener('click', () => {
  document.querySelector('#newPassword').value = generatePassword();
});

async function loadTeam() {
  const list = document.querySelector('#teamList');
  try {
    const r = await authFetch('/api/users');
    const team = await r.json();

    if (team.length === 0) {
      list.innerHTML = '<p class="muted">Aún no hay asesores.</p>';
      return;
    }

    list.innerHTML = team
      .map((u) => {
        const isSelf = currentUser && u.id === currentUser.id;
       const ROLE_LABELS = { admin: 'Administrador', supervisor: 'Supervisor', agent: 'Asesor' };
   const roleLabel = ROLE_LABELS[u.role] || u.role;
        const statusBadge = u.is_active
          ? '<span class="badge connected">Activo</span>'
          : '<span class="badge pending">Inactivo</span>';
        const toggleBtn = isAdmin
          ? `<button class="remove-btn toggle-btn" data-id="${u.id}" data-active="${u.is_active}" ${isSelf && u.is_active ? 'disabled title="No puedes desactivar tu propia cuenta"' : ''} style="color:${u.is_active ? '#b42318' : '#027a48'}">${u.is_active ? 'Desactivar' : 'Activar'}</button>`
          : '';
        const resetBtn = isAdmin
          ? `<button class="remove-btn reset-btn" data-id="${u.id}" data-name="${escapeHtml(u.name)}" style="color:#2563eb">Resetear contraseña</button>`
          : '';
        return `
          <div class="channel-row">
            <div class="meta">
              <strong>${escapeHtml(u.name)} ${isSelf ? '(tú)' : ''}</strong>
              <span>${escapeHtml(u.email)} · ${roleLabel}</span>
            </div>
            <div style="display:flex;align-items:center;gap:12px">
              ${statusBadge}
              ${resetBtn}
              ${toggleBtn}
            </div>
          </div>`;
      })
      .join('');

    list.querySelectorAll('.toggle-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const active = btn.dataset.active === 'true';
        const confirmMsg = active
          ? '¿Desactivar a este asesor? Ya no podrá iniciar sesión, pero sus leads y su historial se conservan.'
          : '¿Reactivar a este asesor?';
        if (!confirm(confirmMsg)) return;

        await authFetch(`/api/users/${btn.dataset.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !active })
        });
        loadTeam();
      });
    });

    list.querySelectorAll('.reset-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const newPass = generatePassword();
        if (!confirm(`Nueva contraseña para ${btn.dataset.name}:\n\n${newPass}\n\nCópiala antes de continuar — no se volverá a mostrar. ¿Confirmar el cambio?`)) {
          return;
        }
        const r = await authFetch(`/api/users/${btn.dataset.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: newPass })
        });
        if (r.ok) {
          alert(`Contraseña actualizada. Entrégasela a ${btn.dataset.name}:\n\n${newPass}`);
        } else {
          alert('No se pudo resetear la contraseña.');
        }
      });
    });
  } catch {
    list.innerHTML = '<p class="muted">No se pudo cargar el equipo.</p>';
  }
}

if (isAdmin) {
  document.querySelector('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.querySelector('#createError');
    const successBox = document.querySelector('#createSuccess');
    errorBox.classList.remove('visible');
    successBox.classList.remove('visible');

    const form = new FormData(e.target);
    const body = {
      name: form.get('name'),
      email: form.get('email'),
      password: form.get('password'),
      role: form.get('role')
    };

    try {
      const r = await authFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok) {
        errorBox.textContent = data.error || 'No se pudo crear el asesor.';
        errorBox.classList.add('visible');
        return;
      }
      successBox.textContent = `Cuenta creada. Entrega estas credenciales a ${data.name}: correo ${data.email}, contraseña la que generaste arriba.`;
      successBox.classList.add('visible');
      e.target.reset();
      loadTeam();
    } catch {
      errorBox.textContent = 'Error de conexión al crear el asesor.';
      errorBox.classList.add('visible');
    }
  });
}

loadTeam();
