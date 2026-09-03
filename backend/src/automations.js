import { sendWhatsAppText } from './meta.js';
import { sendInstagramText } from './instagramApi.js';
import { decryptSecret } from './crypto.js';

// Se llama solo cuando un lead se acaba de crear (no en cada mensaje que llega).
// Si el negocio tiene activado el mensaje de bienvenida, lo envía por el mismo
// canal por el que escribió el lead, y lo guarda como un mensaje saliente más
// en la conversación (para que se vea en el hilo del inbox, igual que si lo
// hubiera escrito un asesor).
export async function maybeSendWelcomeMessage(client, ctx) {
  const {
    tenantId,
    conversationId,
    channelType,
    channelExternalId,
    accessTokenEncrypted,
    recipientPhone,
    recipientIgsid
  } = ctx;

  const tenant = await client.query(
    'SELECT welcome_message_enabled, welcome_message FROM tenants WHERE id = $1',
    [tenantId]
  );
  const settings = tenant.rows[0];
  if (!settings || !settings.welcome_message_enabled || !settings.welcome_message) return;

  const token = accessTokenEncrypted ? decryptSecret(accessTokenEncrypted) : null;

  try {
    let sendResult;
    if (channelType === 'whatsapp') {
      if (!recipientPhone) return;
      sendResult = await sendWhatsAppText(
        recipientPhone,
        settings.welcome_message,
        token ? { accessToken: token, phoneNumberId: channelExternalId } : {}
      );
    } else if (channelType === 'instagram') {
      if (!recipientIgsid || !token) return; // Instagram no tiene respaldo global de credenciales
      sendResult = await sendInstagramText(
        channelExternalId,
        recipientIgsid,
        settings.welcome_message,
        token
      );
    } else {
      return;
    }

    const externalMessageId =
      (sendResult.messages && sendResult.messages[0] && sendResult.messages[0].id) ||
      sendResult.message_id ||
      null;

    await client.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, external_message_id, direction, message_type, body, raw_payload)
       VALUES ($1, $2, $3, 'outbound', 'text', $4, $5)`,
      [tenantId, conversationId, externalMessageId, settings.welcome_message, JSON.stringify(sendResult)]
    );
    await client.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [
      conversationId
    ]);
  } catch (error) {
    // Un fallo de red/Meta al enviar el mensaje de bienvenida no debe tumbar
    // el procesamiento del webhook — el lead y su primer mensaje ya se guardaron.
    console.error('No se pudo enviar el mensaje de bienvenida automático:', error.message);
  }
}
