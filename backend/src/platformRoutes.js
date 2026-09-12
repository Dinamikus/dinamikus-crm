import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth, requirePlatformAdmin, hashPassword } from './auth.js';
import { seedDefaultPipelineStages } from './pipelineStagesSeed.js';

export const platformRouter = Router();
platformRouter.use(requireAuth, requirePlatformAdmin);

// GET /api/platform/tenants — TODOS los negocios registrados en la plataforma,
// sin importar de qué tenant seas — solo accesible para el dueño de la plataforma.
platformRouter.get('/tenants', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.name, t.is_active, t.created_at,
              COUNT(u.id)::int AS user_count,
              (SELECT u2.email FROM users u2 WHERE u2.tenant_id = t.id AND u2.role = 'admin'
               ORDER BY u2.created_at ASC LIMIT 1) AS admin_email,
              MAX(l.created_at) AS last_lead_at
       FROM tenants t
       LEFT JOIN users u ON u.tenant_id = t.id
       LEFT JOIN leads l ON l.tenant_id = t.id
       GROUP BY t.id
       ORDER BY t.created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/platform/tenants — tú creas un negocio nuevo con su primer admin,
// en vez de que el cliente se autoregistre. Tú defines la contraseña aquí mismo
// para entregársela directamente — mismo patrón que ya usas para crear asesores
// en "Equipo", pero a nivel de negocio completo.
platformRouter.post('/tenants', async (req, res) => {
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
      return res.status(409).json({ error: 'Ese correo ya está registrado' });
    }

    const tenantResult = await client.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, is_active, created_at',
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

    await seedDefaultPipelineStages(client, tenant.id);

    await client.query('COMMIT');
    res.status(201).json({ tenant, admin: user });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// PATCH /api/platform/tenants/:id — pausar o reactivar un negocio completo.
// Al pausarlo, TODOS sus usuarios pierden acceso de inmediato (requireAuth lo
// revisa en cada petición), sin borrar absolutamente nada de su información.
platformRouter.patch('/tenants/:id', async (req, res) => {
  const { isActive } = req.body || {};
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'isActive must be a boolean' });
  }

  try {
    const result = await pool.query(
      'UPDATE tenants SET is_active = $1 WHERE id = $2 RETURNING id, name, is_active',
      [isActive, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Tenant not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
