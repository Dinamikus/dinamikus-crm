import { pool } from './db.js';
import { autoAssignLead } from './assignment.js';
import { maybeSendWelcomeMessage } from './automations.js';
import { safeJsonStringify } from './jsonUtils.js';
import { getDefaultStageKey } from './leadsRoutes.js';

// Punto único de "qué pasa cuando llega un mensaje" para cualquier canal (WhatsApp
// Cloud API, Instagram, o WhatsApp por QR). Aquí vive la regla que evita duplicados:
// un lead se crea UNA sola vez por (tenant, identificador) — mensajes siguientes del
// mismo contacto reutilizan el lead y la conversación abierta que ya existía, así que
// el reparto automático y el mensaje de bienvenida solo se disparan la primera vez.
//
// identifyBy: 'phone' upserta por (tenant_id, phone); 'external_user_id' upserta por
// (tenant_id, channel_id, external_user_id) — para canales donde el contacto no tiene
// un número de teléfono real (Instagram).
export async function ingestInboundMessage({
  tenantId,
  channelId,
  channelType,
  channelExternalId,
  channelAccessTokenEncrypted,
  channelOwnerUserId,
  identifyBy,
  fromId,
  secondaryExternalId,
  contactName,
  externalMessageId,
  messageType,
  body,
  mediaKey,
  mediaMimeType,
  rawPayload
}) {
  const client = await pool.connect();
  let isNewLead = false;
  let conversationIdForWelcome = null;
  try {
    await client.query('BEGIN');

    const defaultStage = await getDefaultStageKey(tenantId);
    let leadResult;
    if (identifyBy === 'phone') {
      const extId = secondaryExternalId || fromId;

      // Si ya existe un lead de este MISMO contacto creado antes solo por su LID
      // (porque su primer mensaje no traía el teléfono), complétalo con el teléfono
      // en vez de crear uno nuevo — evita duplicar al mismo cliente.
      if (secondaryExternalId) {
        const existingByLid = await client.query(
          `SELECT id FROM leads WHERE tenant_id = $1 AND channel_id = $2
           AND external_user_id = $3 AND phone IS NULL`,
          [tenantId, channelId, secondaryExternalId]
        );
        if (existingByLid.rowCount > 0) {
          const updated = await client.query(
            `UPDATE leads SET phone = $1, name = COALESCE(name, $2), updated_at = NOW()
             WHERE id = $3 RETURNING id, false AS is_new`,
            [fromId, contactName, existingByLid.rows[0].id]
          );
          leadResult = updated;
        }
      }

      if (!leadResult) {
        leadResult = await client.query(
          `INSERT INTO leads (tenant_id, channel_id, name, phone, external_user_id, source, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
           DO UPDATE SET
             name = COALESCE(leads.name, EXCLUDED.name),
             external_user_id = COALESCE(EXCLUDED.external_user_id, leads.external_user_id),
             updated_at = NOW()
           RETURNING id, (xmax = 0) AS is_new`,
          [tenantId, channelId, contactName, fromId, extId, channelType, defaultStage]
        );
      }
    } else {
      leadResult = await client.query(
        `INSERT INTO leads (tenant_id, channel_id, name, external_user_id, source, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, channel_id, external_user_id) WHERE external_user_id IS NOT NULL AND phone IS NULL
         DO UPDATE SET name = COALESCE(leads.name, EXCLUDED.name), updated_at = NOW()
         RETURNING id, (xmax = 0) AS is_new`,
        [tenantId, channelId, contactName, fromId, channelType, defaultStage]
      );
    }
    const leadId = leadResult.rows[0].id;
    isNewLead = leadResult.rows[0].is_new;

    if (isNewLead) {
      if (channelOwnerUserId) {
        // Canal personal de un asesor (ej. su WhatsApp por QR) — el lead es suyo
        // directamente, sin pasar por el reparto automático entre todo el equipo.
        await client.query('UPDATE leads SET assigned_user_id = $1 WHERE id = $2', [
          channelOwnerUserId,
          leadId
        ]);
      } else {
        await autoAssignLead(client, tenantId, leadId);
      }
    }

    // Reutiliza la conversación abierta más reciente para ese lead+canal, o crea una nueva.
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

    await client.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, external_message_id, direction, sender_external_id, message_type, body, media_key, media_mime_type, raw_payload)
       VALUES ($1, $2, $3, 'inbound', $4, $5, $6, $7, $8, $9)
       ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
       DO NOTHING`,
      [
        tenantId,
        conversationId,
        externalMessageId || null,
        fromId,
        messageType || 'text',
        body,
        mediaKey || null,
        mediaMimeType || null,
        safeJsonStringify(rawPayload || {})
      ]
    );

    await client.query('COMMIT');

    // El mensaje de bienvenida automático solo aplica a canales del negocio en general;
    // en un canal personal (QR de un asesor) no tendría sentido — es su chat personal.
    if (isNewLead && conversationIdForWelcome && !channelOwnerUserId) {
      await maybeSendWelcomeMessage(client, {
        tenantId,
        conversationId: conversationIdForWelcome,
        channelType,
        channelExternalId,
        accessTokenEncrypted: channelAccessTokenEncrypted,
        recipientPhone: identifyBy === 'phone' ? fromId : undefined,
        recipientIgsid: identifyBy === 'external_user_id' ? fromId : undefined
      });
    }

    return { leadId, conversationId, isNewLead };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error guardando mensaje entrante:', error);
    return null;
  } finally {
    client.release();
  }
}

// Para cuando el asesor responde desde SU PROPIO celular (no desde el CRM) — solo
// aplica a canales personales tipo WhatsApp QR. No crea leads ni dispara automatizaciones,
// solo deja constancia del mensaje saliente en la conversación para que el hilo del
// inbox quede completo.
export async function ingestOutboundMessageFromDevice({
  tenantId,
  channelId,
  candidateIds,
  externalMessageId,
  messageType,
  body,
  mediaKey,
  mediaMimeType,
  rawPayload
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ids = (Array.isArray(candidateIds) ? candidateIds : [candidateIds]).filter(Boolean);
    if (ids.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    // Busca por CUALQUIERA de los identificadores que tengamos (teléfono y/o LID) —
    // así, si este mensaje en particular solo trae el LID, igual encuentra el lead
    // que ya se había creado antes con el teléfono real resuelto de un mensaje anterior.
    const lead = await client.query(
      `SELECT id FROM leads WHERE tenant_id = $1 AND channel_id = $2
       AND (phone = ANY($3::text[]) OR external_user_id = ANY($3::text[]))`,
      [tenantId, channelId, ids]
    );
    if (lead.rowCount === 0) {
      // No hay lead para este destinatario todavía — no es una conversación que
      // el CRM esté siguiendo (ej. el asesor le escribió a un amigo), se ignora.
      await client.query('ROLLBACK');
      return null;
    }
    const leadId = lead.rows[0].id;

    let conversationId;
    const openConversation = await client.query(
      `SELECT id FROM conversations WHERE lead_id = $1 AND channel_id = $2 AND status = 'open'
       ORDER BY updated_at DESC LIMIT 1`,
      [leadId, channelId]
    );
    if (openConversation.rowCount > 0) {
      conversationId = openConversation.rows[0].id;
    } else {
      const newConversation = await client.query(
        `INSERT INTO conversations (tenant_id, lead_id, channel_id, status)
         VALUES ($1, $2, $3, 'open') RETURNING id`,
        [tenantId, leadId, channelId]
      );
      conversationId = newConversation.rows[0].id;
    }

    await client.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, external_message_id, direction, message_type, body, media_key, media_mime_type, raw_payload)
       VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8)
       ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
       DO NOTHING`,
      [
        tenantId,
        conversationId,
        externalMessageId || null,
        messageType || 'text',
        body,
        mediaKey || null,
        mediaMimeType || null,
        safeJsonStringify(rawPayload || {})
      ]
    );
    await client.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);

    await client.query('COMMIT');
    return { leadId, conversationId };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error guardando mensaje saliente desde el dispositivo:', error);
    return null;
  } finally {
    client.release();
  }
}
