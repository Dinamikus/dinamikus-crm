import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth, requireRole, hashPassword } from './auth.js';
import { getTeamAgentIds } from './teamScope.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

// GET /api/users?active=true&scope=team — asesores del tenant. Por defecto trae
// todos (activos e inactivos) para la pantalla de gestión de equipo; ?active=true
// filtra solo los activos (para poblar selectores de asignación). ?scope=team,
// cuando lo pide un supervisor, limita la lista a los asesores de SU equipo
// (para que su selector de "asignar a" no ofrezca gente de otro equipo).
usersRouter.get('/', async (req, res) => {
  const { active, scope } = req.query;
  const params = [req.user.tenantId];
  const filters = [];

  if (active === 'true') filters.push('u.is_active = true');

  if (scope === 'team' && req.user.role === 'supervisor') {
    const teamAgentIds = await getTeamAgentIds(req.user.tenantId, req.user.id);
    if (teamAgentIds.length === 0) {
      return res.json([]); // supervisor sin equipo asignado todavía
    }
    params.push(teamAgentIds);
    filters.push(`u.id = ANY($${params.length}::uuid[])`);
  }

  const filter = filters.length ? `AND ${filters.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_active, u.team_id, t.name AS team_name, u.created_at
       FROM users u LEFT JOIN teams t ON t.id = u.team_id
       WHERE u.tenant_id = $1 ${filter} ORDER BY u.is_active DESC, u.name ASC`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/users — solo un admin puede crear credenciales para un asesor nuevo.
// El admin define la contraseña aquí mismo para entregársela directamente al asesor.
usersRouter.post('/', requireRole('admin'), async (req, res) => {
  const { name, email, password, role, teamId } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (role && !['admin', 'supervisor', 'agent'].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin', 'supervisor' or 'agent'" });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [
      email.toLowerCase()
    ]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'Email is already registered' });
    }

    if (teamId) {
      const team = await pool.query('SELECT id FROM teams WHERE id = $1 AND tenant_id = $2', [
        teamId,
        req.user.tenantId
      ]);
      if (team.rowCount === 0) return res.status(400).json({ error: 'teamId no pertenece a este negocio' });
    }

    const passwordHash = await hashPassword(password);
    const result = await pool.query(
      `INSERT INTO users (tenant_id, name, email, password_hash, role, is_active, team_id)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       RETURNING id, name, email, role, is_active, team_id, created_at`,
      [req.user.tenantId, name, email.toLowerCase(), passwordHash, role || 'agent', teamId || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/users/:id — solo un admin: activar/desactivar, cambiar rol, mover
// de equipo, o resetear la contraseña (por rotación de personal).
usersRouter.patch('/:id', requireRole('admin'), async (req, res) => {
  const { isActive, role, name, password, teamId } = req.body || {};
  const touchesTeam = Object.prototype.hasOwnProperty.call(req.body || {}, 'teamId');

  if (req.params.id === req.user.id && isActive === false) {
    return res.status(400).json({ error: 'No puedes desactivar tu propia cuenta' });
  }
  if (role && !['admin', 'supervisor', 'agent'].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin', 'supervisor' or 'agent'" });
  }
  if (password && password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    if (touchesTeam && teamId) {
      const team = await pool.query('SELECT id FROM teams WHERE id = $1 AND tenant_id = $2', [
        teamId,
        req.user.tenantId
      ]);
      if (team.rowCount === 0) return res.status(400).json({ error: 'teamId no pertenece a este negocio' });
    }

    const setClauses = [];
    const params = [];

    if (typeof isActive === 'boolean') {
      params.push(isActive);
      setClauses.push(`is_active = $${params.length}`);
    }
    if (role) {
      params.push(role);
      setClauses.push(`role = $${params.length}`);
    }
    if (name) {
      params.push(name);
      setClauses.push(`name = $${params.length}`);
    }
    if (password) {
      params.push(await hashPassword(password));
      setClauses.push(`password_hash = $${params.length}`);
    }
    if (touchesTeam) {
      params.push(teamId || null);
      setClauses.push(`team_id = $${params.length}`);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    params.push(req.params.id, req.user.tenantId);
    const result = await pool.query(
      `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING id, name, email, role, is_active, team_id, created_at`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
