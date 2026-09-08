import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth, requireRole } from './auth.js';
import { getTeamAgentIds } from './teamScope.js';

export const leadsRouter = Router();
leadsRouter.use(requireAuth);

const ALLOWED_STATUSES = ['new', 'contacted', 'follow_up', 'appointment', 'won', 'not_interested'];

// Modelo de permisos por rol:
// - admin: ve y edita todo (estado, notas, asignación) sin restricción.
// - supervisor: ve los leads de los asesores de SU equipo (más los sin asignar,
//   para poder repartirlos) — nunca los de otro supervisor/equipo. Puede
//   REASIGNARLOS, pero solo hacia asesores de su propio equipo, y no puede
//   tocar estado ni notas — no es su función operar el lead, solo repartir el trabajo.
// - agent: ve y edita (estado/notas) solo sus propios leads asignados, y NUNCA
//   puede reasignar (ni el suyo a otro, ni verse leads ajenos cambiando el id).

// GET /api/leads?assignedUserId=...&unassigned=true — lista de leads del tenant.
leadsRouter.get('/', async (req, res) => {
  const { assignedUserId, unassigned } = req.query;
  const { role } = req.user;
  const params = [req.user.tenantId];
  const filters = [];

  if (role === 'agent') {
    params.push(req.user.id);
    filters.push(`l.assigned_user_id = $${params.length}`);
  } else if (role === 'supervisor') {
    const teamAgentIds = await getTeamAgentIds(req.user.tenantId, req.user.id);
    params.push(teamAgentIds);
    filters.push(`(l.assigned_user_id = ANY($${params.length}::uuid[]) OR l.assigned_user_id IS NULL)`);

    if (unassigned === 'true') {
      filters.push('l.assigned_user_id IS NULL');
    } else if (assignedUserId && teamAgentIds.includes(assignedUserId)) {
      params.push(assignedUserId);
      filters.push(`l.assigned_user_id = $${params.length}`);
    }
  } else if (unassigned === 'true') {
    filters.push('l.assigned_user_id IS NULL');
  } else if (assignedUserId) {
    params.push(assignedUserId);
    filters.push(`l.assigned_user_id = $${params.length}`);
  }

  const filter = filters.length ? `AND ${filters.join(' AND ')}` : '';

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

    let teamAgentIds = null;
    if (role === 'supervisor') {
      teamAgentIds = await getTeamAgentIds(req.user.tenantId, req.user.id);

      const current = await pool.query(
        'SELECT assigned_user_id FROM leads WHERE id = $1 AND tenant_id = $2',
        [req.params.id, req.user.tenantId]
      );
      if (current.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
      const currentlyAssignedTo = current.rows[0].assigned_user_id;
      const inScope = currentlyAssignedTo === null || teamAgentIds.includes(currentlyAssignedTo);
      if (!inScope) return res.status(404).json({ error: 'Lead not found' });
    }

    if (touchesAssignment && assignedUserId) {
      const agent = await pool.query('SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [
        assignedUserId,
        req.user.tenantId
      ]);
      if (agent.rowCount === 0) {
        return res.status(400).json({ error: 'assignedUserId does not belong to this tenant' });
      }
      if (role === 'supervisor' && !teamAgentIds.includes(assignedUserId)) {
        return res.status(403).json({ error: 'Solo puedes reasignar leads a un asesor de tu propio equipo' });
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

// POST /api/leads — crear un lead manualmente (arregla el botón "+ Nuevo lead"
// del dashboard). Un agent que crea uno queda asignado automáticamente a sí
// mismo — si lo está agregando a mano, seguramente ya es suyo (referido,
// contacto directo, etc). Un admin puede asignarlo a quien quiera, o dejarlo
// sin asignar. Un supervisor no crea leads — su función es repartir los que
// ya existen, no dar de alta contactos nuevos.
leadsRouter.post('/', async (req, res) => {
  const { role } = req.user;
  if (role === 'supervisor') {
    return res.status(403).json({ error: 'Un supervisor no puede crear leads nuevos' });
  }

  const { phone: rawPhone, name, notes, assignedUserId } = req.body || {};
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return res.status(400).json({ error: 'phone es obligatorio y debe ser un número válido' });
  }

  let finalAssignee = null;
  if (role === 'agent') {
    finalAssignee = req.user.id; // siempre asignado a quien lo crea
  } else if (role === 'admin' && assignedUserId) {
    const agent = await pool.query('SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [
      assignedUserId,
      req.user.tenantId
    ]);
    if (agent.rowCount === 0) {
      return res.status(400).json({ error: 'assignedUserId no pertenece a este negocio' });
    }
    finalAssignee = assignedUserId;
  }

  try {
    const result = await pool.query(
      `INSERT INTO leads (tenant_id, name, phone, source, status, notes, assigned_user_id)
       VALUES ($1, $2, $3, 'manual', 'new', $4, $5)
       RETURNING id, name, phone, source, status, assigned_user_id, created_at`,
      [req.user.tenantId, name ? String(name).trim().slice(0, 200) : null, phone, notes || null, finalAssignee]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un lead con ese número de teléfono' });
    }
    res.status(500).json({ error: error.message });
  }
});

// POST /api/leads/import — carga masiva de números (ej. desde un formulario de
// Facebook Ads exportado a Excel/CSV). Solo admin: es una acción de datos a nivel
// de negocio, no de un lead individual. Los que ya existen (por teléfono) se
// omiten — no pisa leads que ya tienen una conversación en curso.
leadsRouter.post('/import', requireRole('admin'), async (req, res) => {
  const { leads, source, assignedUserId } = req.body || {};

  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'leads must be a non-empty array' });
  }
  if (leads.length > 5000) {
    return res.status(400).json({ error: 'Máximo 5000 registros por importación' });
  }

  if (assignedUserId) {
    const agent = await pool.query('SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [
      assignedUserId,
      req.user.tenantId
    ]);
    if (agent.rowCount === 0) {
      return res.status(400).json({ error: 'assignedUserId does not belong to this tenant' });
    }
  }

  const sourceLabel = (source && String(source).trim()) || 'import';
  let imported = 0;
  let skippedDuplicate = 0;
  let skippedInvalid = 0;

  try {
    for (const row of leads) {
      const rawPhone = row && row.phone;
      const phone = normalizePhone(rawPhone);
      if (!phone) {
        skippedInvalid++;
        continue;
      }

      const name = row && row.name ? String(row.name).trim().slice(0, 200) : null;

      const result = await pool.query(
        `INSERT INTO leads (tenant_id, name, phone, source, status, assigned_user_id)
         VALUES ($1, $2, $3, $4, 'new', $5)
         ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL DO NOTHING
         RETURNING id`,
        [req.user.tenantId, name, phone, sourceLabel, assignedUserId || null]
      );

      if (result.rowCount > 0) imported++;
      else skippedDuplicate++;
    }

    res.json({ imported, skippedDuplicate, skippedInvalid, total: leads.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Deja solo dígitos — acepta números con +, espacios, guiones o paréntesis tal
// como suelen venir en un Excel exportado, y los normaliza al mismo formato que
// usa el resto del sistema (solo dígitos, con código de país, sin símbolos).
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}
