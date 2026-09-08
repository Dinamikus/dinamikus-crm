-- Backfill: los leads de WhatsApp QR creados ANTES de este arreglo (contactos que
-- llegaron como @lid) se guardaron sin teléfono. Esta migración recupera el
-- número real desde el campo "senderPn" que Baileys ya traía en el mensaje
-- guardado (raw_payload), y no lo estábamos usando.
-- Es segura de correr más de una vez — solo toca leads que hoy no tienen teléfono.

UPDATE leads l
SET phone = sub.phone_from_pn, updated_at = NOW()
FROM (
  SELECT DISTINCT ON (c.lead_id)
    c.lead_id,
    regexp_replace(m.raw_payload->'key'->>'senderPn', '@.*$', '') AS phone_from_pn
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  JOIN channels ch ON ch.id = c.channel_id
  WHERE ch.type = 'whatsapp_qr'
    AND m.direction = 'inbound'
    AND m.raw_payload->'key'->>'senderPn' IS NOT NULL
  ORDER BY c.lead_id, m.created_at ASC
) sub
WHERE l.id = sub.lead_id
  AND l.phone IS NULL
  AND l.external_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM leads l2
    WHERE l2.tenant_id = l.tenant_id AND l2.phone = sub.phone_from_pn
  );
