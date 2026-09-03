import { pool } from './db.js';
import { autoAssignLead } from './assignment.js';
import { maybeSendWelcomeMessage } from './automations.js';

// Procesa un payload de webhook de WhatsApp Cloud API.
// Estructura esperada (Meta): entry[].changes[].value.{metadata, contacts, messages, statuses}
export async function processInboundWebhook(payload) {
  if (!payload || !Array.isArray(payload.entry)) return;

  for (const entry of payload.entry) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};

      // Confirmaciones de entrega/lectura no representan un lead nuevo; se ignoran por ahora.
      if (!Array.isArray(value.messages) || value.messages.length === 0) continue;

      const phoneNumberId = value.metadata && value.metadata.phone_number_id;
      if (!phoneNumberId) {
        console.warn('Webhook sin phone_number_id, no se puede resolver el tenant');
        continue;
      }

      const channel = await findChannelByExternalId('whatsapp', phoneNumberId);
      if (!channel) {
        console.warn(`Webhook de un phone_number_id no registrado: ${phoneNumberId}`);
        continue;
      }

      const contactsByWaId = {};
      for (const contact of value.contacts || []) {
        contactsByWaId[contact.wa_id] = contact.profile ? contact.profile.name : null;
      }

      for (const message of value.messages) {
        await ingestInboundMessage({
          tenantId: channel.tenant_id,
          channelId: channel.id,
          channelExternalId: channel.external_id,
          channelAccessTokenEncrypted: channel.access_token_encrypted,
          fromWaId: message.from,
          contactName: contactsByWaId[message.from] || null,
          message
        });
      }
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
  fromWaId,
  contactName,
  message
}) {
  const client = await pool.connect();
  let isNewLead = false;
  let conversationIdForWelcome = null;
  try {
    await client.query('BEGIN');

    // 1. Upsert del lead por (tenant_id, phone). Si ya existe, actualiza el nombre solo si no tenía uno.
    const leadResult = await client.query(
      `INSERT INTO leads (tenant_id, channel_id, name, phone, external_user_id, source, status)
       VALUES ($1, $2, $3, $4, $5, 'whatsapp', 'new')
       ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
       DO UPDATE SET
         name = COALESCE(leads.name, EXCLUDED.name),
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS is_new`,
      [tenantId, channelId, contactName, fromWaId, fromWaId]
    );
    const leadId = leadResult.rows[0].id;
    isNewLead = leadResult.rows[0].is_new;

    // El reparto automático solo aplica a leads recién creados, no a cada mensaje
    // que llega de un contacto que ya existía.
    if (isNewLead) {
      await autoAssignLead(client, tenantId, leadId);
    }

    // 2. Reutiliza la conversación abierta más reciente para ese lead+canal, o crea una nueva.
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

    // 3. Guarda el mensaje (idempotente por external_message_id dentro de la conversación).
    const body = extractMessageBody(message);
    await client.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, external_message_id, direction, sender_external_id, message_type, body, raw_payload)
       VALUES ($1, $2, $3, 'inbound', $4, $5, $6, $7)
       ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
       DO NOTHING`,
      [tenantId, conversationId, message.id, fromWaId, message.type, body, JSON.stringify(message)]
    );

    await client.query('COMMIT');

    if (isNewLead && conversationIdForWelcome) {
      await maybeSendWelcomeMessage(client, {
        tenantId,
        conversationId: conversationIdForWelcome,
        channelType: 'whatsapp',
        channelExternalId,
        accessTokenEncrypted: channelAccessTokenEncrypted,
        recipientPhone: fromWaId
      });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error guardando mensaje entrante:', error);
  } finally {
    client.release();
  }
}

// Extrae un texto legible del mensaje según su tipo. Tipos sin texto directo
// (imagen, audio, ubicación, etc.) se resumen con una etiqueta.
function extractMessageBody(message) {
  switch (message.type) {
    case 'text':
      return message.text && message.text.body;
    case 'button':
      return message.button && message.button.text;
    case 'interactive':
      return (
        (message.interactive &&
          ((message.interactive.button_reply && message.interactive.button_reply.title) ||
            (message.interactive.list_reply && message.interactive.list_reply.title))) ||
        null
      );
    case 'image':
      return '[imagen]';
    case 'audio':
      return '[audio]';
    case 'video':
      return '[video]';
    case 'document':
      return '[documento]';
    case 'location':
      return '[ubicación]';
    case 'sticker':
      return '[sticker]';
    default:
      return null;
  }
}
