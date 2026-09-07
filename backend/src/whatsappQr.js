import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore } from 'baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { pool } from './db.js';
import { usePostgresAuthState, deletePostgresAuthState } from './whatsappQrAuthState.js';
import { ingestInboundMessage, ingestOutboundMessageFromDevice } from './inboundMessage.js';

// Sesiones activas en memoria: channelId -> { sock, qrDataUrl, status }.
// Vive mientras el proceso de Node esté corriendo — por eso reconnectAllOnBoot()
// se llama al arrancar el servidor, para reconectar solas las sesiones que ya
// habían escaneado el QR antes de un redeploy.
const sessions = new Map();
const logger = pino({ level: 'silent' });

export function getSession(channelId) {
  return sessions.get(channelId) || null;
}

export async function startSession(channelId, tenantId, ownerUserId) {
  // Si ya hay una sesión viva para este canal, no crear otra.
  const current = sessions.get(channelId);
  if (current && current.sock) return current;

  const { state, saveCreds } = await usePostgresAuthState(channelId);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    printQRInTerminal: false,
    browser: ['Dinamikus CRM', 'Chrome', '1.0']
  });

  const entry = { sock, qrDataUrl: null, status: 'pending' };
  sessions.set(channelId, entry);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      entry.qrDataUrl = await QRCode.toDataURL(qr);
      entry.status = 'pending';
      await pool.query('UPDATE channels SET status = $1 WHERE id = $2', ['pending', channelId]);
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qrDataUrl = null;
      const jid = sock.user && sock.user.id;
      const phone = jid ? jid.split(':')[0].split('@')[0] : null;
      console.log(`[whatsapp_qr ${channelId}] conectado correctamente, numero: ${phone}`);
      await pool.query(
        `UPDATE channels SET status = 'connected', external_id = COALESCE($1, external_id) WHERE id = $2`,
        [phone, channelId]
      );
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect && lastDisconnect.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : null;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      sessions.delete(channelId);

      if (loggedOut) {
        await pool.query("UPDATE channels SET status = 'disconnected' WHERE id = $1", [channelId]);
        await deletePostgresAuthState(channelId);
      } else {
        // Corte de red/reinicio, no un cierre de sesión real — reintenta solo.
        await pool.query("UPDATE channels SET status = 'pending' WHERE id = $1", [channelId]);
        setTimeout(() => {
          startSession(channelId, tenantId, ownerUserId).catch((err) =>
            console.error('Error reconectando canal WhatsApp QR:', channelId, err.message)
          );
        }, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[whatsapp_qr ${channelId}] messages.upsert type=${type} count=${messages.length}`);
    if (type !== 'notify') return;

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid || '';
      console.log(
        `[whatsapp_qr ${channelId}] mensaje de ${remoteJid} fromMe=${msg.key.fromMe} tieneMensaje=${!!msg.message}`
      );

      if (!msg.message || remoteJid === 'status@broadcast') continue;

      const isLid = remoteJid.endsWith('@lid');
      const isPhoneJid = remoteJid.endsWith('@s.whatsapp.net');
      if (!isLid && !isPhoneJid) {
        console.log(`[whatsapp_qr ${channelId}] jid ignorado (no es chat 1:1): ${remoteJid}`);
        continue;
      }

      const contactId = remoteJid.split('@')[0];
      const body = extractText(msg.message);
      console.log(`[whatsapp_qr ${channelId}] texto extraido: ${JSON.stringify(body)}`);
      if (!body) continue; // adjuntos sin texto: se omiten en esta primera versión

      const channelRow = await pool.query('SELECT external_id FROM channels WHERE id = $1', [
        channelId
      ]);
      const channelExternalId = channelRow.rows[0] && channelRow.rows[0].external_id;

      if (msg.key.fromMe) {
        // El asesor respondió desde su propio celular, fuera del CRM.
        await ingestOutboundMessageFromDevice({
          tenantId,
          channelId,
          identifyBy: isLid ? 'external_user_id' : 'phone',
          toId: contactId,
          externalMessageId: msg.key.id,
          messageType: 'text',
          body,
          rawPayload: msg
        });
      } else {
        const result = await ingestInboundMessage({
          tenantId,
          channelId,
          channelType: 'whatsapp_qr',
          channelExternalId,
          channelAccessTokenEncrypted: null,
          channelOwnerUserId: ownerUserId,
          identifyBy: isLid ? 'external_user_id' : 'phone',
          fromId: contactId,
          contactName: msg.pushName || null,
          externalMessageId: msg.key.id,
          messageType: 'text',
          body,
          rawPayload: msg
        });
        console.log(`[whatsapp_qr ${channelId}] ingestInboundMessage resultado:`, result);
      }
    }
  });

  return entry;
}

export async function stopSession(channelId, { logout }) {
  const entry = sessions.get(channelId);
  if (entry && entry.sock) {
    try {
      if (logout) await entry.sock.logout();
      else entry.sock.end(undefined);
    } catch {
      /* la conexión puede ya estar cerrada */
    }
  }
  sessions.delete(channelId);
  if (logout) await deletePostgresAuthState(channelId);
}

export async function sendQrMessage(channelId, toId, text, jidType = 'phone') {
  const entry = sessions.get(channelId);
  if (!entry || !entry.sock || entry.status !== 'connected') {
    throw new Error('Este canal de WhatsApp (QR) no está conectado en este momento');
  }
  const suffix = jidType === 'lid' ? '@lid' : '@s.whatsapp.net';
  const jid = `${toId}${suffix}`;
  const result = await entry.sock.sendMessage(jid, { text });
  return result;
}

// Se llama una vez al arrancar el servidor: reconecta solas las sesiones que ya
// habían sido escaneadas antes del último redeploy, usando las credenciales
// guardadas en Postgres — el asesor no tiene que volver a escanear nada.
export async function reconnectAllOnBoot() {
  const result = await pool.query(
    `SELECT id, tenant_id, owner_user_id FROM channels
     WHERE type = 'whatsapp_qr' AND status IN ('connected', 'pending')`
  );
  for (const row of result.rows) {
    startSession(row.id, row.tenant_id, row.owner_user_id).catch((err) =>
      console.error('Error reconectando canal WhatsApp QR al arrancar:', row.id, err.message)
    );
  }
}

function extractText(message) {
  return (
    message.conversation ||
    (message.extendedTextMessage && message.extendedTextMessage.text) ||
    (message.imageMessage && message.imageMessage.caption) ||
    (message.videoMessage && message.videoMessage.caption) ||
    null
  );
}
