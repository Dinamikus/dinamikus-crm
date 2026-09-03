import 'dotenv/config';

const graphVersion = process.env.META_GRAPH_VERSION;
const defaultAccessToken = process.env.META_ACCESS_TOKEN;
const defaultPhoneNumberId = process.env.META_PHONE_NUMBER_ID;

// overrides permite usar el access_token y phone_number_id propios de un canal
// (conectado por el negocio vía Embedded Signup) en vez de las credenciales
// globales del .env, que solo existen para pruebas/desarrollo inicial.
export async function sendWhatsAppText(to, body, overrides = {}) {
  const accessToken = overrides.accessToken || defaultAccessToken;
  const phoneNumberId = overrides.phoneNumberId || defaultPhoneNumberId;

  if (!graphVersion || !accessToken || !phoneNumberId) {
    throw new Error('Meta WhatsApp credentials are not configured');
  }

  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Meta API error: ${JSON.stringify(data)}`);
  }

  return data;
}
