import { pool } from './db.js';
import { ingestInboundMessage } from './inboundMessage.js';
import { decryptSecret } from './crypto.js';
import { uploadMedia, mediaConfigured, extensionForMime } from './mediaStorage.js';

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];

// Procesa un payload de webhook de WhatsApp Cloud API.
// Estructura esperada (Meta): entry[].changes[].value.{metadata, contacts, messages, statuses}
export async function processInboundWebhook(payload) {
  if (!payload || !Array.isArray(payload.entry)) return;

  for (const entry of payload.entry) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};

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
        let mediaKey = null;
        let mediaMimeType = null;

        if (MEDIA_TYPES.includes(message.type) && mediaConfigured()) {
          try {
            const accessToken = channel.access_token_encrypted
              ? decryptSecret(channel.access_token_encrypted)
              : process.env.META_ACCESS_TOKEN;
            const media = message[message.type];
            const downloaded = await downloadMetaMedia(media.id, accessToken);
            mediaKey = await uploadMedia({
              tenantId: channel.tenant_id,
              channelId: channel.id,
              messageExternalId: message.id,
              buffer: downloaded.buffer,
              mimeType: downloaded.mimeType,
              extension: extensionForMime(downloaded.mimeType, media.filename)
            });
            mediaMimeType = downloaded.mimeType;
          } catch (err) {
            console.error('Error descargando/subiendo multimedia de WhatsApp Cloud API:', err.message);
          }
        }

        await ingestInboundMessage({
          tenantId: channel.tenant_id,
          channelId: channel.id,
          channelType: 'whatsapp',
          channelExternalId: channel.external_id,
          channelAccessTokenEncrypted: channel.access_token_encrypted,
          channelOwnerUserId: null,
          identifyBy: 'phone',
          fromId: message.from,
          contactName: contactsByWaId[message.from] || null,
          externalMessageId: message.id,
          messageType: message.type,
          body: extractMessageBody(message),
          mediaKey,
          mediaMimeType,
          rawPayload: message
        });
      }
    }
  }
}

// Descarga un archivo de WhatsApp Cloud API: primero se pide la URL temporal del
// archivo (expira en minutos), y luego se descarga el contenido real con el
// mismo token — así lo guardamos permanentemente en nuestro propio almacenamiento.
async function downloadMetaMedia(mediaId, accessToken) {
  const graphVersion = process.env.META_GRAPH_VERSION || 'v21.0';
  const metaRes = await fetch(`https://graph.facebook.com/${graphVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!metaRes.ok) throw new Error(`No se pudo obtener la URL del archivo (HTTP ${metaRes.status})`);
  const { url, mime_type: mimeType } = await metaRes.json();

  const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!fileRes.ok) throw new Error(`No se pudo descargar el archivo (HTTP ${fileRes.status})`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimeType };
}

async function findChannelByExternalId(type, externalId) {
  const result = await pool.query(
    'SELECT id, tenant_id, external_id, access_token_encrypted FROM channels WHERE type = $1 AND external_id = $2',
    [type, externalId]
  );
  return result.rows[0] || null;
}

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
