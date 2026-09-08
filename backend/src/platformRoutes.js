import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth, requirePlatformAdmin } from './auth.js';

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
