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
// Las columnas por etapa reflejan el estado ACTUAL del lead (no llevamos historial de
// cambios de estado todavía), y son las etapas REALES de este negocio — cada tenant
// tiene su propio pipeline, así que las columnas varían de un negocio a otro.
reportsRouter.get('/advisors', requireRole('admin', 'supervisor'), async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' });
  }

  try {
    const stagesResult = await pool.query(
      'SELECT key, label FROM pipeline_stages WHERE tenant_id = $1 ORDER BY position ASC',
      [req.user.tenantId]
    );
    const stages = stagesResult.rows;

    const isSupervisor = req.user.role === 'supervisor';
    const teamAgentIds = isSupervisor ? await getTeamAgentIds(req.user.tenantId, req.user.id) : null;
    const teamFilter = isSupervisor ? 'AND u.id = ANY($4::uuid[])' : '';

    const baseAdvisorParams = isSupervisor
      ? [req.user.tenantId, from, to, teamAgentIds]
      : [req.user.tenantId, from, to];
    const stageParamsStart = baseAdvisorParams.length;
    const advisorParams = [...baseAdvisorParams, ...stages.map((s) => s.key)];
    const stageFilterSql = stages
      .map((s, i) => `COUNT(l.id) FILTER (WHERE l.status = $${stageParamsStart + i + 1}) AS stage_${i}`)
      .join(',\n         ');

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
         ) AS sin_respuesta
         ${stages.length ? ',\n         ' + stageFilterSql : ''}
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

    const advisors = result.rows.map((r) => rowToAdvisorShape(r, stages));

    // El bloque de "sin asignar" solo aplica a la vista completa del admin —
    // para un supervisor, lo que no está asignado a SU equipo no es su alcance.
    let unassignedRow = rowToAdvisorShape(
      { recibidos: 0, en_conversacion: 0, sin_respuesta: 0 },
      stages
    );
    if (!isSupervisor) {
      const unassignedParams = [req.user.tenantId, from, to, ...stages.map((s) => s.key)];
      const unassignedStageFilterSql = stages
        .map((s, i) => `COUNT(l.id) FILTER (WHERE l.status = $${3 + i + 1}) AS stage_${i}`)
        .join(',\n           ');

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
           ) AS sin_respuesta
           ${stages.length ? ',\n           ' + unassignedStageFilterSql : ''}
         FROM leads l
         WHERE l.tenant_id = $1 AND l.assigned_user_id IS NULL
           AND l.created_at >= $2::date
           AND l.created_at < ($3::date + INTERVAL '1 day')`,
        unassignedParams
      );
      unassignedRow = rowToAdvisorShape(unassigned.rows[0], stages);
    }

    res.json({
      stages: stages.map((s) => ({ key: s.key, label: s.label })),
      advisors,
      unassigned: unassignedRow
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Convierte una fila cruda (con columnas genéricas stage_0, stage_1, ...) al
// formato que espera el frontend: los totales fijos + un mapa { key: cantidad }
// con las etapas reales del negocio.
function rowToAdvisorShape(row, stages) {
  const byStage = {};
  stages.forEach((s, i) => {
    byStage[s.key] = Number(row[`stage_${i}`] || 0);
  });
  return {
    advisor_id: row.advisor_id,
    advisor_name: row.advisor_name,
    is_active: row.is_active,
    recibidos: Number(row.recibidos || 0),
    en_conversacion: Number(row.en_conversacion || 0),
    sin_respuesta: Number(row.sin_respuesta || 0),
    by_stage: byStage
  };
}
