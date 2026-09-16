import { pool } from './db.js';
import { sendWhatsAppText } from './meta.js';
import { sendInstagramText } from './instagramApi.js';
import { sendQrMessage } from './whatsappQr.js';
import { decryptSecret } from './crypto.js';
import { safeJsonStringify } from './jsonUtils.js';

// Envía un mensaje saliente a un lead por el canal que le corresponda (WhatsApp
// Cloud API, Instagram, o WhatsApp QR) y lo deja guardado en su conversación,
// igual que si lo hubiera escrito un asesor desde el Inbox. Esta es la misma
// lógica que ya usa POST /api/messages/send, extraída aquí para que el bot (y
// cualquier otro proceso automático, como los recordatorios) la reutilicen sin
// pasar por autenticación de usuario.
export async function sendOutboundToLead({ tenantId, leadId, body }) {
  const leadResult = await pool.query(
    `SELECT l.id, l.phone, l.channel_id, l.external_user_id,
            c.type AS channel_type, c.external_id AS channel_external_id,
            c.access_token_encrypted
     FROM leads l LEFT JOIN channels c ON c.id = l.channel_id
     WHERE l.id = $1 AND l.tenant_id = $2`,
    [leadId, tenantId]
  );
  const lead = leadResult.rows[0];
  if (!lead || !lead.channel_id) {
    throw new Error(`Lead ${leadId} no tiene canal asociado`);
  }

  const channelToken = lead.access_token_encrypted ? decryptSecret(lead.access_token_encrypted) : null;
  let sendResult;

  if (lead.channel_type === 'whatsapp') {
    if (!lead.phone) throw new Error('Lead sin número de teléfono');
    const overrides = channelToken
      ? { accessToken: channelToken, phoneNumberId: lead.channel_external_id }
      : {};
    sendResult = await sendWhatsAppText(lead.phone, body, overrides);
  } else if (lead.channel_type === 'instagram') {
    if (!lead.external_user_id) throw new Error('Lead sin ID de Instagram');
    sendResult = await sendInstagramText(lead.channel_external_id, lead.external_user_id, body, channelToken);
  } else if (lead.channel_type === 'whatsapp_qr') {
    const jidType = lead.phone ? 'phone' : 'lid';
    const toId = lead.phone || lead.external_user_id;
    if (!toId) throw new Error('Lead sin identificador de WhatsApp');
    sendResult = await sendQrMessage(lead.channel_id, toId, body, jidType);
  } else {
    throw new Error(`Canal no soportado: ${lead.channel_type}`);
  }

  const openConversation = await pool.query(
    `SELECT id FROM conversations WHERE lead_id = $1 AND channel_id = $2 AND status = 'open'
     ORDER BY updated_at DESC LIMIT 1`,
    [lead.id, lead.channel_id]
  );
  let conversationId;
  if (openConversation.rowCount > 0) {
    conversationId = openConversation.rows[0].id;
  } else {
    const newConversation = await pool.query(
      `INSERT INTO conversations (tenant_id, lead_id, channel_id, status)
       VALUES ($1, $2, $3, 'open') RETURNING id`,
      [tenantId, lead.id, lead.channel_id]
    );
    conversationId = newConversation.rows[0].id;
  }

  const externalMessageId =
    (sendResult.messages && sendResult.messages[0] && sendResult.messages[0].id) ||
    sendResult.message_id ||
    (sendResult.key && sendResult.key.id) ||
    null;

  await pool.query(
    `INSERT INTO messages (tenant_id, conversation_id, external_message_id, direction, message_type, body, raw_payload)
     VALUES ($1, $2, $3, 'outbound', 'text', $4, $5)`,
    [tenantId, conversationId, externalMessageId, body, safeJsonStringify(sendResult)]
  );
  await pool.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);

  return { conversationId, sendResult };
}
