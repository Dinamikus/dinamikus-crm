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
