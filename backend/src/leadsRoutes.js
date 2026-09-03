import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth } from './auth.js';

export const leadsRouter = Router();
leadsRouter.use(requireAuth);

const ALLOWED_STATUSES = ['new', 'contacted', 'follow_up', 'appointment', 'won', 'not_interested'];

// Modelo de permisos por rol:
// - admin: ve y edita todo (estado, notas, asignación) sin restricción.
// - supervisor: ve TODOS los leads del negocio (no solo los suyos, porque no tiene
//   leads propios) y puede REASIGNARLOS entre asesores, pero no puede tocar
//   estado ni notas — no es su función operar el lead, solo repartir el trabajo.
// - agent: ve y edita (estado/notas) solo sus propios leads asignados, y NUNCA
//   puede reasignar (ni el suyo a otro, ni verse leads ajenos cambiando el id).

// GET /api/leads?assignedUserId=...&unassigned=true — lista de leads del tenant.
leadsRouter.get('/', async (req, res) => {
  const { assignedUserId, unassigned } = req.query;
  const isAgent = req.user.role === 'agent';
  const params = [req.user.tenantId];
  let filter = '';

  if (isAgent) {
    params.push(req.user.id);
    filter = `AND l.assigned_user_id = $${params.length}`;
  } else if (unassigned === 'true') {
    filter = 'AND l.assigned_user_id IS NULL';
  } else if (assignedUserId) {
    params.push(assignedUserId);
    filter = `AND l.assigned_user_id = $${params.length}`;
  }

  try {
    const result = await pool.query(
      `SELECT l.id, l.name, l.phone, l.source, l.service_interest, l.status, l.notes,
              l.assigned_user_id, u.name AS assigned_user_name,
              l.created_at, l.updated_at
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_user_id
       WHERE l.tenant_id = $1 ${filter}
       ORDER BY l.updated_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/leads/:id — actualizar estado/notas/asignación, según el rol (ver arriba).
leadsRouter.patch('/:id', async (req, res) => {
  const { status, notes } = req.body || {};
  const touchesAssignment = Object.prototype.hasOwnProperty.call(req.body || {}, 'assignedUserId');
  const touchesStatusOrNotes = status !== undefined || notes !== undefined;
  const assignedUserId = touchesAssignment ? req.body.assignedUserId : undefined;
  const { role } = req.user;

  if (status && !ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
  }

  if (role === 'agent' && touchesAssignment) {
    return res.status(403).json({ error: 'Solo un administrador o supervisor puede reasignar leads' });
  }
  if (role === 'supervisor' && touchesStatusOrNotes) {
    return res.status(403).json({ error: 'Un supervisor solo puede reasignar leads, no cambiar su estado o notas' });
  }

  try {
    if (role === 'agent') {
      const owns = await pool.query(
        'SELECT id FROM leads WHERE id = $1 AND tenant_id = $2 AND assigned_user_id = $3',
        [req.params.id, req.user.tenantId, req.user.id]
      );
      if (owns.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
    }

    if (touchesAssignment && assignedUserId) {
      const agent = await pool.query('SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [
        assignedUserId,
        req.user.tenantId
      ]);
      if (agent.rowCount === 0) {
        return res.status(400).json({ error: 'assignedUserId does not belong to this tenant' });
      }
    }

    const setClauses = ['status = COALESCE($1, status)', 'notes = COALESCE($2, notes)', 'updated_at = NOW()'];
    const params = [status || null, notes ?? null];

    if (touchesAssignment) {
      params.push(assignedUserId || null);
      setClauses.push(`assigned_user_id = $${params.length}`);
    }

    params.push(req.params.id, req.user.tenantId);
    const result = await pool.query(
      `UPDATE leads SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING id, name, phone, status, notes, assigned_user_id, updated_at`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
