import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth } from './auth.js';
import { startSession, stopSession, getSession } from './whatsappQr.js';

export const whatsappQrRouter = Router();
whatsappQrRouter.use(requireAuth);

// Un supervisor no opera leads personalmente — no tiene sentido que conecte su
// propio WhatsApp para trabajar conversaciones.
function blockSupervisors(req, res, next) {
  if (req.user.role === 'supervisor') {
    return res.status(403).json({ error: 'Los supervisores no conectan su propio WhatsApp' });
  }
  next();
}

// POST /api/channels/whatsapp-qr/start — cualquier asesor conecta SU PROPIO WhatsApp.
// A diferencia de los demás canales, esto no requiere ser admin: cada quien conecta el suyo.
whatsappQrRouter.post('/start', blockSupervisors, async (req, res) => {
  const { displayName } = req.body || {};

  try {
    const result = await pool.query(
      `INSERT INTO channels (tenant_id, type, display_name, status, owner_user_id)
       VALUES ($1, 'whatsapp_qr', $2, 'pending', $3)
       RETURNING id`,
      [req.user.tenantId, displayName || `WhatsApp de ${req.user.id}`, req.user.id]
    );
    const channelId = result.rows[0].id;

    await startSession(channelId, req.user.tenantId, req.user.id);

    res.status(201).json({ channelId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/channels/whatsapp-qr/:channelId/status — para hacer polling desde el frontend
// mientras se espera a que el asesor escanee el QR con su celular.
whatsappQrRouter.get('/:channelId/status', async (req, res) => {
  try {
    const channel = await pool.query(
      'SELECT id, status, external_id, owner_user_id FROM channels WHERE id = $1 AND tenant_id = $2',
      [req.params.channelId, req.user.tenantId]
    );
    if (channel.rowCount === 0) return res.status(404).json({ error: 'Channel not found' });

    const row = channel.rows[0];
    const isOwner = row.owner_user_id === req.user.id;
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No puedes ver este canal' });
    }

    const session = getSession(req.params.channelId);
    res.json({
      status: row.status,
      externalId: row.external_id,
      qrDataUrl: session ? session.qrDataUrl : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/channels/whatsapp-qr/:channelId — desconecta y borra el canal.
// El dueño del canal (el asesor) puede quitarlo él mismo, o un admin.
whatsappQrRouter.delete('/:channelId', async (req, res) => {
  try {
    const channel = await pool.query(
      'SELECT owner_user_id FROM channels WHERE id = $1 AND tenant_id = $2',
      [req.params.channelId, req.user.tenantId]
    );
    if (channel.rowCount === 0) return res.status(404).json({ error: 'Channel not found' });

    const isOwner = channel.rows[0].owner_user_id === req.user.id;
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No puedes quitar este canal' });
    }

    await stopSession(req.params.channelId, { logout: true });
    await pool.query('DELETE FROM channels WHERE id = $1', [req.params.channelId]);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
