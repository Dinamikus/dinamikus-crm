import 'dotenv/config';

const graphVersion = process.env.META_GRAPH_VERSION;
const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;

function assertConfigured() {
  if (!graphVersion || !appId || !appSecret) {
    throw new Error(
      'META_APP_ID, META_APP_SECRET y META_GRAPH_VERSION deben estar configurados en .env'
    );
  }
}

// Paso 1: intercambia el "code" que devuelve el SDK de Facebook (válido solo 30s)
// por un token de negocio de larga duración. Llamada servidor-a-servidor.
export async function exchangeCodeForToken(code) {
  assertConfigured();

  const url = new URL(`https://graph.facebook.com/${graphVersion}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('code', code);

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(`No se pudo intercambiar el código por un token: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

// Paso 2: suscribe esta app a los webhooks del WABA del cliente. Sin esto,
// los mensajes de ese negocio nunca llegan a nuestro webhook.
export async function subscribeAppToWaba(wabaId, accessToken) {
  assertConfigured();

  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/subscribed_apps`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`No se pudo suscribir el webhook al WABA: ${JSON.stringify(data)}`);
  }

  return data;
}

// Paso 3 (informativo): trae el número de teléfono verificado para mostrarlo
// como nombre del canal en vez de solo el ID.
export async function fetchPhoneNumberDisplayName(phoneNumberId, accessToken) {
  assertConfigured();

  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}?fields=display_phone_number,verified_name`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json();

  if (!response.ok) return null; // no bloquea el flujo si esto falla
  return data;
}
