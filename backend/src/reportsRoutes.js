import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth, requireRole } from './auth.js';
import { getTeamAgentIds } from './teamScope.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

// GET /api/reports/advisors?from=YYYY-MM-DD&to=YYYY-MM-DD
// Métricas por asesor de los leads RECIBIDOS en el rango (por fecha de creación del lead).
// "en_conversacion" / "sin_respuesta" se calculan por si el lead tiene al menos un mensaje
// saliente (el asesor o la automatización le respondió), no por su estado actual.
// Las demás columnas son el estado ACTUAL del lead, no el estado que tenía en esa fecha
// (no llevamos historial de cambios de estado todavía).
reportsRouter.get('/advisors', requireRole('admin', 'supervisor'), async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' });
  }

  try {
    const isSupervisor = req.user.role === 'supervisor';
    const teamAgentIds = isSupervisor ? await getTeamAgentIds(req.user.tenantId, req.user.id) : null;
    const teamFilter = isSupervisor ? 'AND u.id = ANY($4::uuid[])' : '';
    const advisorParams = isSupervisor
      ? [req.user.tenantId, from, to, teamAgentIds]
      : [req.user.tenantId, from, to];

    const result = await pool.query(
      `SELECT
         u.id AS advisor_id,
         u.name AS advisor_name,
         u.is_active,
         COUNT(l.id) AS recibidos,
         COUNT(l.id) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id = c.id
             WHERE c.lead_id = l.id AND m.direction = 'outbound'
           )
         ) AS en_conversacion,
         COUNT(l.id) FILTER (
           WHERE NOT EXISTS (
             SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id = c.id
             WHERE c.lead_id = l.id AND m.direction = 'outbound'
           )
         ) AS sin_respuesta,
         COUNT(l.id) FILTER (WHERE l.status = 'follow_up') AS recontacto,
         COUNT(l.id) FILTER (WHERE l.status = 'appointment') AS citas,
         COUNT(l.id) FILTER (WHERE l.status = 'won') AS cierres,
         COUNT(l.id) FILTER (WHERE l.status = 'not_interested') AS no_le_interesa
       FROM users u
       LEFT JOIN leads l ON l.assigned_user_id = u.id
         AND l.tenant_id = u.tenant_id
         AND l.created_at >= $2::date
         AND l.created_at < ($3::date + INTERVAL '1 day')
       WHERE u.tenant_id = $1 ${teamFilter}
       GROUP BY u.id, u.name, u.is_active
       ORDER BY recibidos DESC, u.name ASC`,
      advisorParams
    );

    // El bloque de "sin asignar" solo aplica a la vista completa del admin —
    // para un supervisor, lo que no está asignado a SU equipo no es su alcance.
    let unassignedRow = { recibidos: 0, en_conversacion: 0, sin_respuesta: 0, recontacto: 0, citas: 0, cierres: 0, no_le_interesa: 0 };
    if (!isSupervisor) {
      const unassigned = await pool.query(
        `SELECT
           COUNT(l.id) AS recibidos,
           COUNT(l.id) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id = c.id
               WHERE c.lead_id = l.id AND m.direction = 'outbound'
             )
           ) AS en_conversacion,
           COUNT(l.id) FILTER (
             WHERE NOT EXISTS (
               SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id = c.id
               WHERE c.lead_id = l.id AND m.direction = 'outbound'
             )
           ) AS sin_respuesta,
           COUNT(l.id) FILTER (WHERE l.status = 'follow_up') AS recontacto,
           COUNT(l.id) FILTER (WHERE l.status = 'appointment') AS citas,
           COUNT(l.id) FILTER (WHERE l.status = 'won') AS cierres,
           COUNT(l.id) FILTER (WHERE l.status = 'not_interested') AS no_le_interesa
         FROM leads l
         WHERE l.tenant_id = $1 AND l.assigned_user_id IS NULL
           AND l.created_at >= $2::date
           AND l.created_at < ($3::date + INTERVAL '1 day')`,
        [req.user.tenantId, from, to]
      );
      unassignedRow = unassigned.rows[0];
    }

    res.json({
      advisors: result.rows.map((r) => ({ ...r, recibidos: Number(r.recibidos) })),
      unassigned: unassignedRow
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
