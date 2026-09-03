import 'dotenv/config';

const graphVersion = process.env.META_GRAPH_VERSION;

// A diferencia de WhatsApp, Instagram no tiene credenciales globales de respaldo:
// cada negocio necesita su propio access_token (obtenido al conectar el canal),
// porque no existe un "número" compartido para pruebas como con WhatsApp.
export async function sendInstagramText(igAccountId, recipientIgsid, text, accessToken) {
  if (!graphVersion) throw new Error('META_GRAPH_VERSION no está configurado');
  if (!accessToken) {
    throw new Error('Este canal de Instagram no tiene un access_token conectado todavía');
  }

  const url = `https://graph.facebook.com/${graphVersion}/${igAccountId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      recipient: { id: recipientIgsid },
      message: { text }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Meta API error (Instagram): ${JSON.stringify(data)}`);
  }

  return data;
}
