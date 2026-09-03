import { pool } from './db.js';
import { autoAssignLead } from './assignment.js';
import { maybeSendWelcomeMessage } from './automations.js';

// Procesa un payload de webhook de Instagram Messaging.
// Estructura (Meta): entry[].messaging[].{sender, recipient, message}
// entry.id = el Instagram Account ID (IG_ID) del negocio que recibió el mensaje.
export async function processInboundInstagramWebhook(payload) {
  if (!payload || !Array.isArray(payload.entry)) return;

  for (const entry of payload.entry) {
    const igAccountId = entry.id;
    const messagingEvents = Array.isArray(entry.messaging) ? entry.messaging : [];
    if (!igAccountId || messagingEvents.length === 0) continue;

    const channel = await findChannelByExternalId('instagram', igAccountId);
    if (!channel) {
      console.warn(`Webhook de Instagram de una cuenta no registrada: ${igAccountId}`);
      continue;
    }

    for (const event of messagingEvents) {
      // Los eco de nuestros propios mensajes salientes también llegan por webhook —
      // ya los guardamos nosotros al enviarlos, así que se descartan aquí.
      if (event.message && event.message.is_echo) continue;
      // Postbacks, reacciones, "seen", etc. no traen event.message con texto — se ignoran por ahora.
      if (!event.message) continue;

      await ingestInboundMessage({
        tenantId: channel.tenant_id,
        channelId: channel.id,
        channelExternalId: channel.external_id,
        channelAccessTokenEncrypted: channel.access_token_encrypted,
        fromIgsid: event.sender && event.sender.id,
        message: event.message
      });
    }
  }
}

async function findChannelByExternalId(type, externalId) {
  const result = await pool.query(
    'SELECT id, tenant_id, external_id, access_token_encrypted FROM channels WHERE type = $1 AND external_id = $2',
    [type, externalId]
  );
  return result.rows[0] || null;
}

async function ingestInboundMessage({
  tenantId,
  channelId,
  channelExternalId,
  channelAccessTokenEncrypted,
  fromIgsid,
  message
}) {
  if (!fromIgsid) return;

  const client = await pool.connect();
  let isNewLead = false;
  let conversationIdForWelcome = null;
  try {
    await client.query('BEGIN');

    // Los leads de Instagram no tienen teléfono — se identifican por (tenant, canal, IGSID).
    const leadResult = await client.query(
      `INSERT INTO leads (tenant_id, channel_id, external_user_id, source, status)
       VALUES ($1, $2, $3, 'instagram', 'new')
       ON CONFLICT (tenant_id, channel_id, external_user_id) WHERE external_user_id IS NOT NULL AND phone IS NULL
       DO UPDATE SET updated_at = NOW()
       RETURNING id, (xmax = 0) AS is_new`,
      [tenantId, channelId, fromIgsid]
    );
    const leadId = leadResult.rows[0].id;
    isNewLead = leadResult.rows[0].is_new;

    if (isNewLead) {
      await autoAssignLead(client, tenantId, leadId);
    }

    let conversationId;
    const openConversation = await client.query(
      `SELECT id FROM conversations
       WHERE lead_id = $1 AND channel_id = $2 AND status = 'open'
       ORDER BY updated_at DESC LIMIT 1`,
      [leadId, channelId]
    );

    if (openConversation.rowCount > 0) {
      conversationId = openConversation.rows[0].id;
      await client.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [
        conversationId
      ]);
    } else {
      const newConversation = await client.query(
        `INSERT INTO conversations (tenant_id, lead_id, channel_id, status)
         VALUES ($1, $2, $3, 'open') RETURNING id`,
        [tenantId, leadId, channelId]
      );
      conversationId = newConversation.rows[0].id;
    }
    conversationIdForWelcome = conversationId;

    const body = extractMessageBody(message);
    await client.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, external_message_id, direction, sender_external_id, message_type, body, raw_payload)
       VALUES ($1, $2, $3, 'inbound', $4, $5, $6, $7)
       ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
       DO NOTHING`,
      [
        tenantId,
        conversationId,
        message.mid,
        fromIgsid,
        message.attachments ? 'attachment' : 'text',
        body,
        JSON.stringify(message)
      ]
    );

    await client.query('COMMIT');

    if (isNewLead && conversationIdForWelcome) {
      await maybeSendWelcomeMessage(client, {
        tenantId,
        conversationId: conversationIdForWelcome,
        channelType: 'instagram',
        channelExternalId,
        accessTokenEncrypted: channelAccessTokenEncrypted,
        recipientIgsid: fromIgsid
      });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error guardando mensaje entrante de Instagram:', error);
  } finally {
    client.release();
  }
}

function extractMessageBody(message) {
  if (message.text) return message.text;
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const type = message.attachments[0].type;
    const labels = { image: '[imagen]', video: '[video]', audio: '[audio]', share: '[compartido]' };
    return labels[type] || `[${type || 'adjunto'}]`;
  }
  return null;
}
