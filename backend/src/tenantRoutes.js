import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth, requireRole } from './auth.js';

export const tenantRouter = Router();
tenantRouter.use(requireAuth);

// GET /api/tenant/settings — cualquier usuario del tenant puede consultarla (el inbox
// necesita saber si el reparto automático está activo, por ejemplo).
tenantRouter.get('/settings', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, auto_assign_leads, welcome_message_enabled, welcome_message
       FROM tenants WHERE id = $1`,
      [req.user.tenantId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Tenant not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/tenant/settings — solo un admin puede cambiar la configuración del negocio.
tenantRouter.patch('/settings', requireRole('admin'), async (req, res) => {
  const { autoAssignLeads, welcomeMessageEnabled, welcomeMessage } = req.body || {};

  if (autoAssignLeads === undefined && welcomeMessageEnabled === undefined && welcomeMessage === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  if (autoAssignLeads !== undefined && typeof autoAssignLeads !== 'boolean') {
    return res.status(400).json({ error: 'autoAssignLeads must be a boolean' });
  }
  if (welcomeMessageEnabled !== undefined && typeof welcomeMessageEnabled !== 'boolean') {
    return res.status(400).json({ error: 'welcomeMessageEnabled must be a boolean' });
  }
  if (welcomeMessage !== undefined && (!welcomeMessage || !welcomeMessage.trim())) {
    return res.status(400).json({ error: 'welcomeMessage cannot be empty' });
  }

  try {
    const result = await pool.query(
      `UPDATE tenants SET
         auto_assign_leads = COALESCE($1, auto_assign_leads),
         welcome_message_enabled = COALESCE($2, welcome_message_enabled),
         welcome_message = COALESCE($3, welcome_message)
       WHERE id = $4
       RETURNING id, name, auto_assign_leads, welcome_message_enabled, welcome_message`,
      [
        autoAssignLeads ?? null,
        welcomeMessageEnabled ?? null,
        welcomeMessage ?? null,
        req.user.tenantId
      ]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
