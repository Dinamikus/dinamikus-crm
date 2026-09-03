// Reparto automático: cuando un negocio lo activa (tenants.auto_assign_leads),
// cada lead NUEVO (no cada mensaje) se asigna al asesor con menos leads activos
// asignados en ese momento. Es un round-robin por carga, no por turno fijo —
// así un asesor que se queda atrás no acumula de más solo por orden de llegada.
export async function autoAssignLead(client, tenantId, leadId) {
  const tenant = await client.query('SELECT auto_assign_leads FROM tenants WHERE id = $1', [
    tenantId
  ]);
  if (!tenant.rows[0] || !tenant.rows[0].auto_assign_leads) return null;

  const candidate = await client.query(
    `SELECT u.id
     FROM users u
     LEFT JOIN leads l ON l.assigned_user_id = u.id AND l.status NOT IN ('won','not_interested')
     WHERE u.tenant_id = $1 AND u.is_active = true AND u.role != 'supervisor'
     GROUP BY u.id
     ORDER BY COUNT(l.id) ASC, u.created_at ASC
     LIMIT 1`,
    [tenantId]
  );
  if (candidate.rowCount === 0) return null; // no hay usuarios en el tenant (no debería pasar)

  const agentId = candidate.rows[0].id;
  await client.query('UPDATE leads SET assigned_user_id = $1 WHERE id = $2', [agentId, leadId]);
  return agentId;
}
