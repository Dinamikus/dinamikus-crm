import { Router } from 'express';
import { pool } from './db.js';
import { hashPassword, verifyPassword, signToken, requireAuth } from './auth.js';

export const authRouter = Router();

// POST /api/auth/register
// Crea un nuevo negocio (tenant) junto con su primer usuario admin.
authRouter.post('/register', async (req, res) => {
  const { businessName, adminName, email, password } = req.body || {};

  if (!businessName || !adminName || !email || !password) {
    return res.status(400).json({
      error: 'businessName, adminName, email and password are required'
    });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [
      email.toLowerCase()
    ]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Email is already registered' });
    }

    const tenantResult = await client.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name',
      [businessName]
    );
    const tenant = tenantResult.rows[0];

    const passwordHash = await hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO users (tenant_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin')
       RETURNING id, name, email, role`,
      [tenant.id, adminName, email.toLowerCase(), passwordHash]
    );
    const user = userResult.rows[0];

    await client.query('COMMIT');

    const token = signToken({ sub: user.id, tenantId: tenant.id, role: user.role });
    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: { id: tenant.id, name: tenant.name }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.is_active,
              u.tenant_id, t.name AS tenant_name
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1`,
      [email.toLowerCase()]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'Esta cuenta fue desactivada. Contacta a tu administrador.' });
    }

    const token = signToken({ sub: user.id, tenantId: user.tenant_id, role: user.role });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: { id: user.tenant_id, name: user.tenant_name }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/auth/me — valida el token y devuelve la sesión actual
authRouter.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, t.id AS tenant_id, t.name AS tenant_name
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    const row = result.rows[0];
    res.json({
      user: { id: row.id, name: row.name, email: row.email, role: row.role },
      tenant: { id: row.tenant_id, name: row.tenant_name }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
