import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth } from './auth.js';

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

// GET /api/conversations?status=open&channelId=...&assignedUserId=...&unassigned=true
// Lista conversaciones del tenant con el lead, canal y último mensaje.
// Un admin ve todo el tenant y puede usar los filtros libremente.
// Un agent SOLO ve sus propias conversaciones asignadas — se ignora cualquier
// assignedUserId/unassigned que mande, para que no pueda ver leads de otros
// manipulando la URL.
conversationsRouter.get('/', async (req, res) => {
  const { status, channelId, assignedUserId, unassigned } = req.query;
  const isAgent = req.user.role === 'agent';

  try {
    const params = [req.user.tenantId];
    const filters = [];

    if (status) {
      params.push(status);
      filters.push(`c.status = $${params.length}`);
    }
    if (channelId) {
      params.push(channelId);
      filters.push(`c.channel_id = $${params.length}`);
    }

    if (isAgent) {
      params.push(req.user.id);
      filters.push(`l.assigned_user_id = $${params.length}`);
    } else if (unassigned === 'true') {
      filters.push('l.assigned_user_id IS NULL');
    } else if (assignedUserId) {
      params.push(assignedUserId);
      filters.push(`l.assigned_user_id = $${params.length}`);
    }

    const extraFilter = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT
         c.id, c.status, c.updated_at, c.channel_id,
         l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone, l.status AS lead_status,
         l.assigned_user_id, au.name AS assigned_user_name,
         ch.type AS channel_type, ch.display_name AS channel_display_name,
         lm.body AS last_message_body,
         lm.direction AS last_message_direction,
         lm.created_at AS last_message_at
       FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN users au ON au.id = l.assigned_user_id
       LEFT JOIN LATERAL (
         SELECT body, direction, created_at FROM messages m
         WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC LIMIT 1
       ) lm ON true
       WHERE c.tenant_id = $1 ${extraFilter}
       ORDER BY COALESCE(lm.created_at, c.updated_at) DESC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/conversations/:id/messages — hilo completo de una conversación.
// Un agent recibe 404 (no 403) si la conversación no es suya, para no confirmar
// que existe un lead ajeno con ese id.
conversationsRouter.get('/:id/messages', async (req, res) => {
  try {
    const convo = await pool.query(
      `SELECT c.id, c.channel_id, l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone,
              l.assigned_user_id
       FROM conversations c JOIN leads l ON l.id = c.lead_id
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    );
    if (convo.rowCount === 0) return res.status(404).json({ error: 'Conversation not found' });

    const isAgent = req.user.role === 'agent';
    if (isAgent && convo.rows[0].assigned_user_id !== req.user.id) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = await pool.query(
      `SELECT id, direction, message_type, body, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({ conversation: convo.rows[0], messages: messages.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
