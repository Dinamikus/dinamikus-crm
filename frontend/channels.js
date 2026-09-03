requireSession();

const tenant = getTenant();
if (tenant) document.querySelector('#tenantName').textContent = tenant.name;

const currentUser = JSON.parse(localStorage.getItem('dinamikus_user') || 'null');
const isAdmin = currentUser && currentUser.role === 'admin';

document.querySelector('#logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

// Datos capturados del evento postMessage de Embedded Signup (waba_id, phone_number_id)
// y del callback de FB.login (code). El submit al backend solo pasa cuando tenemos los tres.
let pendingSession = null;

function setError(msg) {
  const box = document.querySelector('#signupError');
  if (!msg) {
    box.classList.remove('visible');
    box.textContent = '';
    return;
  }
  box.textContent = msg;
  box.classList.add('visible');
}

async function loadChannels() {
  const list = document.querySelector('#channelList');
  try {
    const r = await authFetch('/api/channels');
    const channels = await r.json();

    if (channels.length === 0) {
      list.innerHTML = '<p class="muted">Aún no has conectado ningún canal.</p>';
      return;
    }

    list.innerHTML = channels
      .map(
        (c) => `
        <div class="channel-row">
          <div class="meta">
            <strong>${escapeHtml(c.display_name || c.external_id || 'Sin nombre')}</strong>
            <span>${escapeHtml(c.type)} · ${escapeHtml(c.external_id || '')}</span>
          </div>
          <div style="display:flex;align-items:center;gap:14px">
            <span class="badge ${c.status === 'connected' ? 'connected' : 'pending'}">${escapeHtml(c.status)}</span>
            ${isAdmin ? `<button class="remove-btn" data-id="${c.id}">Quitar</button>` : ''}
          </div>
        </div>`
      )
      .join('');

    if (!isAdmin) return; // sin botones que enganchar

    list.querySelectorAll('.remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Quitar este canal? Dejarás de recibir sus mensajes.')) return;
        await authFetch(`/api/channels/${btn.dataset.id}`, { method: 'DELETE' });
        loadChannels();
      });
    });
  } catch {
    list.innerHTML = '<p class="muted">No se pudieron cargar los canales.</p>';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

async function submitEmbeddedSignup() {
  if (!pendingSession || !pendingSession.code || !pendingSession.wabaId || !pendingSession.phoneNumberId) {
    return;
  }
  setError('');
  const btn = document.querySelector('#connectBtn');
  btn.disabled = true;
  btn.textContent = 'Conectando…';

  try {
    const r = await authFetch('/api/channels/whatsapp/embedded-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingSession)
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error || 'No se pudo conectar el canal.');
      return;
    }
    pendingSession = null;
    await loadChannels();
  } catch {
    setError('Error de conexión al conectar el canal.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Conectar con Facebook';
  }
}

async function init() {
  const desc = document.querySelector('#signupDescription');
  const btn = document.querySelector('#connectBtn');
  const manualCard = document.querySelector('#manualCard');
  const signupCard = document.querySelector('#signupCard');

  if (!isAdmin) {
    desc.textContent = 'Solo un administrador puede conectar o quitar canales.';
    manualCard.style.display = 'none';
    loadChannels();
    return;
  }

  let config;
  try {
    const r = await fetch('/api/public-config');
    config = await r.json();
  } catch {
    config = {};
  }

  // El formulario manual siempre está disponible: es la única forma de conectar
  // Instagram por ahora (aún no construimos su Embedded Signup) y sirve de respaldo
  // para WhatsApp si el Embedded Signup no está configurado en este servidor.
  manualCard.style.display = 'block';

  if (!config.metaAppId || !config.metaConfigId) {
    desc.textContent =
      'El Embedded Signup de Meta todavía no está configurado en este servidor (faltan META_APP_ID / META_EMBEDDED_SIGNUP_CONFIG_ID en el .env). Mientras tanto, conecta WhatsApp o Instagram con el formulario manual de abajo.';
  } else {
    desc.textContent = 'Con un clic, el dueño del negocio conecta su WhatsApp Business sin compartirte contraseñas ni copiar IDs a mano. Instagram, por ahora, se conecta con el formulario manual de abajo.';
    btn.style.display = 'inline-block';

    window.fbAsyncInit = function () {
      FB.init({
        appId: config.metaAppId,
        autoLogAppEvents: true,
        xfbml: true,
        version: config.metaGraphVersion || 'v21.0'
      });
    };

    window.addEventListener('message', (event) => {
      if (!event.origin.endsWith('facebook.com')) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'WA_EMBEDDED_SIGNUP' && data.event === 'FINISH') {
          pendingSession = {
            ...pendingSession,
            wabaId: data.data.waba_id,
            phoneNumberId: data.data.phone_number_id
          };
          submitEmbeddedSignup();
        } else if (data.type === 'WA_EMBEDDED_SIGNUP' && data.event === 'CANCEL') {
          setError('Conexión cancelada antes de terminar el flujo.');
        }
      } catch {
        /* mensajes no relacionados con Embedded Signup — se ignoran */
      }
    });

    btn.addEventListener('click', () => {
      setError('');
      if (typeof FB === 'undefined') {
        setError('El SDK de Facebook todavía está cargando, intenta de nuevo en un segundo.');
        return;
      }
      FB.login(
        (response) => {
          if (response.authResponse && response.authResponse.code) {
            pendingSession = { ...pendingSession, code: response.authResponse.code };
            submitEmbeddedSignup();
          }
        },
        {
          config_id: config.metaConfigId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {} }
        }
      );
    });
  }

  loadChannels();

  const manualForm = document.querySelector('#manualForm');
  manualForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.querySelector('#manualError');
    errorBox.classList.remove('visible');

    const form = new FormData(e.target);
    const body = {
      type: form.get('type'),
      externalId: form.get('externalId'),
      displayName: form.get('displayName') || undefined,
      accessToken: form.get('accessToken') || undefined
    };

    try {
      const r = await authFetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok) {
        errorBox.textContent = data.error || 'No se pudo registrar el canal.';
        errorBox.classList.add('visible');
        return;
      }
      manualForm.reset();
      loadChannels();
    } catch {
      errorBox.textContent = 'Error de conexión al registrar el canal.';
      errorBox.classList.add('visible');
    }
  });
}

init();
