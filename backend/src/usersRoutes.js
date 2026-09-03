import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth, requireRole, hashPassword } from './auth.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

// GET /api/users?active=true — asesores del tenant. Por defecto trae todos
// (activos e inactivos) para la pantalla de gestión de equipo; ?active=true
// filtra solo los activos (para poblar selectores de asignación).
usersRouter.get('/', async (req, res) => {
  const { active } = req.query;
  const params = [req.user.tenantId];
  let filter = '';
  if (active === 'true') {
    filter = 'AND is_active = true';
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, role, is_active, created_at
       FROM users WHERE tenant_id = $1 ${filter} ORDER BY is_active DESC, name ASC`,
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
  const { name, email, password, role } = req.body || {};

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

    const passwordHash = await hashPassword(password);
    const result = await pool.query(
      `INSERT INTO users (tenant_id, name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, name, email, role, is_active, created_at`,
      [req.user.tenantId, name, email.toLowerCase(), passwordHash, role || 'agent']
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/users/:id — solo un admin: activar/desactivar, cambiar rol, o
// resetear la contraseña (por rotación de personal: reutilizar el acceso
// para el reemplazo, o simplemente desactivar a quien se fue).
usersRouter.patch('/:id', requireRole('admin'), async (req, res) => {
  const { isActive, role, name, password } = req.body || {};

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

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    params.push(req.params.id, req.user.tenantId);
    const result = await pool.query(
      `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING id, name, email, role, is_active, created_at`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
