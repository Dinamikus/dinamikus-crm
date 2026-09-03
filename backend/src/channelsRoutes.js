import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth, requireRole } from './auth.js';
import { encryptSecret } from './crypto.js';
import {
  exchangeCodeForToken,
  subscribeAppToWaba,
  fetchPhoneNumberDisplayName
} from './metaOnboarding.js';

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

// GET /api/channels — lista los canales del tenant autenticado
channelsRouter.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, type, external_id, external_waba_id, display_name, status, created_at
       FROM channels WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [req.user.tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/channels/whatsapp/embedded-signup
// Recibe lo que devuelve el flujo de Embedded Signup de Meta en el frontend:
// - code: token de un solo uso (30s de vida) que el SDK entrega en el callback de FB.login
// - wabaId y phoneNumberId: vienen del listener de postMessage (evento WA_EMBEDDED_SIGNUP)
// Aquí se hace todo el trabajo servidor-a-servidor: intercambiar el code por un token de negocio,
// suscribir esta app a los webhooks del WABA del cliente, y guardar el canal ya conectado.
channelsRouter.post('/whatsapp/embedded-signup', requireRole('admin'), async (req, res) => {
  const { code, wabaId, phoneNumberId } = req.body || {};

  if (!code || !wabaId || !phoneNumberId) {
    return res.status(400).json({ error: 'code, wabaId and phoneNumberId are required' });
  }

  try {
    const businessToken = await exchangeCodeForToken(code);
    await subscribeAppToWaba(wabaId, businessToken);

    const phoneInfo = await fetchPhoneNumberDisplayName(phoneNumberId, businessToken);
    const displayName =
      (phoneInfo && (phoneInfo.verified_name || phoneInfo.display_phone_number)) || null;

    const encryptedToken = encryptSecret(businessToken);

    // Si el número ya estaba conectado a este mismo tenant (reintento del flujo),
    // actualiza el token; si pertenece a otro tenant, el índice único lo rechaza.
    const result = await pool.query(
      `INSERT INTO channels (tenant_id, type, external_id, external_waba_id, display_name, access_token_encrypted, status)
       VALUES ($1, 'whatsapp', $2, $3, $4, $5, 'connected')
       ON CONFLICT (type, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET
         external_waba_id = EXCLUDED.external_waba_id,
         display_name = COALESCE(EXCLUDED.display_name, channels.display_name),
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         status = 'connected'
       WHERE channels.tenant_id = $1
       RETURNING id, type, external_id, external_waba_id, display_name, status, created_at`,
      [req.user.tenantId, phoneNumberId, wabaId, displayName, encryptedToken]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'Este número ya está conectado a otro negocio' });
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/channels
// Registro manual de un canal (fallback). Para WhatsApp, externalId = Phone Number ID de Meta.
// Para Instagram, externalId = Instagram Account ID (IG_ID).
// accessToken es opcional para WhatsApp (existe respaldo global en .env) pero
// prácticamente obligatorio para Instagram si no usaste el Embedded Signup —
// sin él, el canal puede recibir mensajes pero no puede responder.
channelsRouter.post('/', requireRole('admin'), async (req, res) => {
  const { type, externalId, displayName, accessToken } = req.body || {};
  const validTypes = ['whatsapp', 'instagram', 'messenger'];

  if (!type || !validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }
  if (!externalId) {
    return res.status(400).json({ error: 'externalId is required (e.g. Meta Phone Number ID / Instagram Account ID)' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO channels (tenant_id, type, external_id, display_name, access_token_encrypted, status)
       VALUES ($1, $2, $3, $4, $5, 'connected')
       RETURNING id, type, external_id, display_name, status, created_at`,
      [
        req.user.tenantId,
        type,
        externalId,
        displayName || null,
        accessToken ? encryptSecret(accessToken) : null
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This channel is already registered to a tenant' });
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/channels/:id
channelsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM channels WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, req.user.tenantId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Channel not found' });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
