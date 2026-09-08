// Helpers de sesión compartidos por todas las páginas del frontend.

function getToken() {
  return localStorage.getItem('dinamikus_token');
}

function setSession(token, user, tenant) {
  localStorage.setItem('dinamikus_token', token);
  localStorage.setItem('dinamikus_user', JSON.stringify(user));
  localStorage.setItem('dinamikus_tenant', JSON.stringify(tenant));
}

function clearSession() {
  localStorage.removeItem('dinamikus_token');
  localStorage.removeItem('dinamikus_user');
  localStorage.removeItem('dinamikus_tenant');
}

function getTenant() {
  try {
    return JSON.parse(localStorage.getItem('dinamikus_tenant') || 'null');
  } catch {
    return null;
  }
}

// Redirige a login si no hay token. Llamar al inicio de páginas protegidas.
function requireSession() {
  if (!getToken()) {
    window.location.href = '/login.html';
  }
}

// Wrapper de fetch que agrega el token y maneja sesiones expiradas (401).
async function authFetch(url, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    clearSession();
    window.location.href = '/login.html';
    throw new Error('Session expired');
  }

  return response;
}

function logout() {
  clearSession();
  window.location.href = '/login.html';
}

// Menú móvil: el sidebar de escritorio se convierte en un panel deslizante en
// pantallas angostas. Se activa solo en páginas que tienen sidebar (no en
// login/register). Se llama directo (no en DOMContentLoaded) porque este script
// carga al final del body, cuando el DOM ya está listo.
function setupMobileNav() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar || document.querySelector('.mobile-nav-toggle')) return;

  const toggle = document.createElement('button');
  toggle.className = 'mobile-nav-toggle';
  toggle.setAttribute('aria-label', 'Abrir menú');
  toggle.textContent = '☰';
  document.body.prepend(toggle);

  const backdrop = document.createElement('div');
  backdrop.className = 'sidebar-backdrop';
  document.body.appendChild(backdrop);

  function closeNav() {
    sidebar.classList.remove('mobile-open');
    backdrop.classList.remove('visible');
  }
  function openNav() {
    sidebar.classList.add('mobile-open');
    backdrop.classList.add('visible');
  }

  toggle.addEventListener('click', () => {
    sidebar.classList.contains('mobile-open') ? closeNav() : openNav();
  });
  backdrop.addEventListener('click', closeNav);
  sidebar.querySelectorAll('nav a').forEach((a) => a.addEventListener('click', closeNav));
}
setupMobileNav();

// Solo el dueño de la plataforma ve este link — se agrega por código para no
// tener que tocar el HTML de cada página. Cualquier otro usuario nunca lo ve.
function setupPlatformNavLink() {
  const nav = document.querySelector('.sidebar nav');
  const user = JSON.parse(localStorage.getItem('dinamikus_user') || 'null');
  if (!nav || !user || !user.isPlatformAdmin || nav.querySelector('a[href="/platform.html"]')) return;

  const link = document.createElement('a');
  link.href = '/platform.html';
  link.textContent = 'Plataforma';
  if (window.location.pathname === '/platform.html') link.className = 'active';
  nav.appendChild(link);
}
setupPlatformNavLink();
