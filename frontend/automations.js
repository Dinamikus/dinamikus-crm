requireSession();

const tenant = getTenant();
if (tenant) document.querySelector('#tenantName').textContent = tenant.name;

const currentUser = JSON.parse(localStorage.getItem('dinamikus_user') || 'null');
const isAdmin = currentUser && currentUser.role === 'admin';

document.querySelector('#logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

const toggle = document.querySelector('#welcomeEnabledToggle');
const textarea = document.querySelector('#welcomeMessageText');
const saveBtn = document.querySelector('#saveWelcomeBtn');
const errorBox = document.querySelector('#welcomeError');
const statusLabel = document.querySelector('#saveStatus');

if (!isAdmin) {
  toggle.disabled = true;
  textarea.disabled = true;
  saveBtn.style.display = 'none';
  document.querySelector('#readOnlyNotice').style.display = 'block';
}

async function loadSettings() {
  try {
    const r = await authFetch('/api/tenant/settings');
    const settings = await r.json();
    toggle.checked = !!settings.welcome_message_enabled;
    textarea.value = settings.welcome_message || '';
  } catch {
    errorBox.textContent = 'No se pudo cargar la configuración.';
    errorBox.classList.add('visible');
  }
}

if (isAdmin) {
  saveBtn.addEventListener('click', async () => {
    errorBox.classList.remove('visible');
    statusLabel.textContent = '';

    if (!textarea.value.trim()) {
      errorBox.textContent = 'El mensaje no puede estar vacío.';
      errorBox.classList.add('visible');
      return;
    }

    saveBtn.disabled = true;
    try {
      const r = await authFetch('/api/tenant/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          welcomeMessageEnabled: toggle.checked,
          welcomeMessage: textarea.value.trim()
        })
      });
      if (!r.ok) {
        const data = await r.json();
        errorBox.textContent = data.error || 'No se pudo guardar.';
        errorBox.classList.add('visible');
        return;
      }
      statusLabel.textContent = 'Guardado ✓';
      setTimeout(() => { statusLabel.textContent = ''; }, 2500);
    } catch {
      errorBox.textContent = 'Error de conexión al guardar.';
      errorBox.classList.add('visible');
    } finally {
      saveBtn.disabled = false;
    }
  });
}

loadSettings();
