import { pool } from './db.js';
import { ingestInboundMessage } from './inboundMessage.js';

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
      if (event.message && event.message.is_echo) continue;
      if (!event.message) continue;

      const fromIgsid = event.sender && event.sender.id;
      if (!fromIgsid) continue;

      await ingestInboundMessage({
        tenantId: channel.tenant_id,
        channelId: channel.id,
        channelType: 'instagram',
        channelExternalId: channel.external_id,
        channelAccessTokenEncrypted: channel.access_token_encrypted,
        channelOwnerUserId: null,
        identifyBy: 'external_user_id',
        fromId: fromIgsid,
        contactName: null,
        externalMessageId: event.message.mid,
        messageType: event.message.attachments ? 'attachment' : 'text',
        body: extractMessageBody(event.message),
        rawPayload: event.message
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

function extractMessageBody(message) {
  if (message.text) return message.text;
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const type = message.attachments[0].type;
    const labels = { image: '[imagen]', video: '[video]', audio: '[audio]', share: '[compartido]' };
    return labels[type] || `[${type || 'adjunto'}]`;
  }
  return null;
}
