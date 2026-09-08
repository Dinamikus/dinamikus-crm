import { pool } from './db.js';

// IDs de los usuarios que pertenecen a algún equipo que supervisa este supervisor.
// Un supervisor puede (en teoría) tener más de un equipo asignado; se juntan todos.
export async function getTeamAgentIds(tenantId, supervisorId) {
  const result = await pool.query(
    `SELECT u.id FROM users u
     WHERE u.tenant_id = $1 AND u.team_id IN (
       SELECT id FROM teams WHERE tenant_id = $1 AND supervisor_id = $2
     )`,
    [tenantId, supervisorId]
  );
  return result.rows.map((r) => r.id);
}

export async function getSupervisedTeamIds(tenantId, supervisorId) {
  const result = await pool.query('SELECT id FROM teams WHERE tenant_id = $1 AND supervisor_id = $2', [
    tenantId,
    supervisorId
  ]);
  return result.rows.map((r) => r.id);
}
