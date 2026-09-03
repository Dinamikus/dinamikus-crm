import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { pool } from './db.js';
import { sendWhatsAppText } from './meta.js';
import { sendInstagramText } from './instagramApi.js';
import { authRouter } from './authRoutes.js';
import { channelsRouter } from './channelsRoutes.js';
import { conversationsRouter } from './conversationsRoutes.js';
import { leadsRouter } from './leadsRoutes.js';
import { usersRouter } from './usersRoutes.js';
import { tenantRouter } from './tenantRoutes.js';
import { reportsRouter } from './reportsRoutes.js';
import { requireAuth } from './auth.js';
import { processInboundWebhook } from './whatsapp.js';
import { processInboundInstagramWebhook } from './instagram.js';
import { decryptSecret } from './crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../../frontend')));

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: true });
  } catch {
    res.status(500).json({ ok: false, database: false });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/channels', channelsRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/users', usersRouter);
app.use('/api/tenant', tenantRouter);
app.use('/api/reports', reportsRouter);

// Config pública (no-secreta) que el frontend necesita para iniciar el SDK de Facebook.
app.get('/api/public-config', (_req, res) => {
  res.json({
    metaAppId: process.env.META_APP_ID || null,
    metaConfigId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || null,
    metaGraphVersion: process.env.META_GRAPH_VERSION || null
  });
});

// Dashboard data — escopado al tenant autenticado
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const { tenantId } = req.user;
    const total = await pool.query('SELECT COUNT(*)::int AS count FROM leads WHERE tenant_id = $1', [
      tenantId
    ]);
    const open = await pool.query(
      "SELECT COUNT(*)::int AS count FROM leads WHERE tenant_id = $1 AND status IN ('new','contacted','follow_up')",
      [tenantId]
    );
    res.json({
      totalLeads: total.rows[0].count,
      openLeads: open.rows[0].count
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WhatsApp webhook verification
app.get('/api/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// WhatsApp webhook receiver
app.post('/api/webhooks/whatsapp', async (req, res) => {
  // Acknowledge quickly. El procesamiento pesado puede moverse a una cola en producción,
  // pero para el volumen de un MVP procesarlo inline después de responder es suficiente.
  res.sendStatus(200);

  try {
    await processInboundWebhook(req.body);
  } catch (error) {
    console.error('Webhook processing error:', error);
  }
});

// Instagram webhook verification (mismo token que WhatsApp — se configura una vez por app en Meta)
app.get('/api/webhooks/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Instagram webhook receiver
app.post('/api/webhooks/instagram', async (req, res) => {
  res.sendStatus(200);

  try {
    await processInboundInstagramWebhook(req.body);
  } catch (error) {
    console.error('Instagram webhook processing error:', error);
  }
});

// Envío saliente ligado a un lead existente — guarda el mensaje en su conversación.
// Enruta a WhatsApp o Instagram según el tipo de canal del lead. Para WhatsApp usa el
// token propio del canal (Embedded Signup) o cae a las credenciales globales del .env;
// Instagram no tiene respaldo global, así que requiere un token propio del canal.
app.post('/api/messages/send', requireAuth, async (req, res) => {
  const { leadId, body } = req.body || {};
  if (!leadId || !body) return res.status(400).json({ error: 'leadId and body are required' });

  try {
    const leadResult = await pool.query(
      `SELECT l.id, l.phone, l.channel_id, l.external_user_id, l.assigned_user_id,
              c.type AS channel_type, c.external_id AS channel_external_id,
              c.access_token_encrypted
       FROM leads l LEFT JOIN channels c ON c.id = l.channel_id
       WHERE l.id = $1 AND l.tenant_id = $2`,
      [leadId, req.user.tenantId]
    );
    const lead = leadResult.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (req.user.role === 'supervisor') {
      return res.status(403).json({ error: 'Un supervisor no puede enviar mensajes' });
    }
    if (req.user.role === 'agent' && lead.assigned_user_id !== req.user.id) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    if (!lead.channel_id) return res.status(400).json({ error: 'Lead has no channel on file' });

    const channelToken = lead.access_token_encrypted ? decryptSecret(lead.access_token_encrypted) : null;
    let sendResult;

    if (lead.channel_type === 'whatsapp') {
      if (!lead.phone) return res.status(400).json({ error: 'Lead has no phone number on file' });
      const overrides = channelToken
        ? { accessToken: channelToken, phoneNumberId: lead.channel_external_id }
        : {};
      sendResult = await sendWhatsAppText(lead.phone, body, overrides);
    } else if (lead.channel_type === 'instagram') {
      if (!lead.external_user_id) {
        return res.status(400).json({ error: 'Lead has no Instagram-scoped ID on file' });
      }
      sendResult = await sendInstagramText(
        lead.channel_external_id,
        lead.external_user_id,
        body,
        channelToken
      );
    } else {
      return res.status(400).json({ error: `Unsupported channel type: ${lead.channel_type}` });
    }

    const openConversation = await pool.query(
      `SELECT id FROM conversations WHERE lead_id = $1 AND channel_id = $2 AND status = 'open'
       ORDER BY updated_at DESC LIMIT 1`,
      [lead.id, lead.channel_id]
    );
    let conversationId;
    if (openConversation.rowCount > 0) {
      conversationId = openConversation.rows[0].id;
    } else {
      const newConversation = await pool.query(
        `INSERT INTO conversations (tenant_id, lead_id, channel_id, status)
         VALUES ($1, $2, $3, 'open') RETURNING id`,
        [req.user.tenantId, lead.id, lead.channel_id]
      );
      conversationId = newConversation.rows[0].id;
    }

    const externalMessageId =
      (sendResult.messages && sendResult.messages[0] && sendResult.messages[0].id) ||
      sendResult.message_id ||
      null;

    await pool.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, external_message_id, direction, message_type, body, raw_payload)
       VALUES ($1, $2, $3, 'outbound', 'text', $4, $5)`,
      [req.user.tenantId, conversationId, externalMessageId, body, JSON.stringify(sendResult)]
    );
    await pool.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);

    res.json({ ...sendResult, conversationId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/*splat', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`CRM SaaS running on port ${port}`));
