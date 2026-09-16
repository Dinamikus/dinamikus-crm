import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth, requireRole } from './auth.js';

export const botRouter = Router();
botRouter.use(requireAuth);

const CONFIG_COLUMNS = `tenant_id, activo, tipo_bot, nombre_negocio, direccion, horario_atencion,
  timezone, recordatorio_24h, recordatorio_2h, recontacto_no_show, dias_recontacto_no_show,
  max_reintentos_no_entendido, appointment_stage_key`;

// GET /api/bot/config — crea la fila con valores por defecto la primera vez que
// se pide (así el frontend no tiene que distinguir "aún no existe" de "existe
// pero vacía"). Incluye si hay un canal de WhatsApp del negocio conectado
// (owner_user_id NULL) — el bot no sirve de nada sin uno.
botRouter.get('/config', async (req, res) => {
  try {
    await pool.query('INSERT INTO bot_config (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [
      req.user.tenantId
    ]);
    const config = await pool.query(`SELECT ${CONFIG_COLUMNS} FROM bot_config WHERE tenant_id = $1`, [
      req.user.tenantId
    ]);
    const channel = await pool.query(
      `SELECT id, status FROM channels
       WHERE tenant_id = $1 AND type = 'whatsapp_qr' AND owner_user_id IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.tenantId]
    );
    res.json({
      ...config.rows[0],
      canalNegocio: channel.rows[0] || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/bot/config — solo admin. Cualquier campo omitido conserva su
// valor actual (COALESCE contra la fila existente, que get ya garantiza que existe).
botRouter.patch('/config', requireRole('admin'), async (req, res) => {
  const {
    activo,
    nombreNegocio,
    direccion,
    horarioAtencion,
    timezone,
    recordatorio24h,
    recordatorio2h,
    recontactoNoShow,
    diasRecontactoNoShow,
    maxReintentosNoEntendido,
    appointmentStageKey
  } = req.body || {};

  try {
    await pool.query('INSERT INTO bot_config (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [
      req.user.tenantId
    ]);
    const result = await pool.query(
      `UPDATE bot_config SET
         activo = COALESCE($1, activo),
         nombre_negocio = COALESCE($2, nombre_negocio),
         direccion = COALESCE($3, direccion),
         horario_atencion = COALESCE($4, horario_atencion),
         timezone = COALESCE($5, timezone),
         recordatorio_24h = COALESCE($6, recordatorio_24h),
         recordatorio_2h = COALESCE($7, recordatorio_2h),
         recontacto_no_show = COALESCE($8, recontacto_no_show),
         dias_recontacto_no_show = COALESCE($9, dias_recontacto_no_show),
         max_reintentos_no_entendido = COALESCE($10, max_reintentos_no_entendido),
         -- appointment_stage_key SÍ acepta null explícito (para "no mover de etapa"),
         -- así que usa un centinela: el frontend manda '' para limpiarlo.
         appointment_stage_key = CASE WHEN $11::text IS NULL THEN appointment_stage_key
                                       WHEN $11::text = '' THEN NULL
                                       ELSE $11::text END,
         updated_at = NOW()
       WHERE tenant_id = $12
       RETURNING ${CONFIG_COLUMNS}`,
      [
        typeof activo === 'boolean' ? activo : null,
        nombreNegocio ?? null,
        direccion ?? null,
        horarioAtencion ? JSON.stringify(horarioAtencion) : null,
        timezone ?? null,
        typeof recordatorio24h === 'boolean' ? recordatorio24h : null,
        typeof recordatorio2h === 'boolean' ? recordatorio2h : null,
        typeof recontactoNoShow === 'boolean' ? recontactoNoShow : null,
        Number.isInteger(diasRecontactoNoShow) ? diasRecontactoNoShow : null,
        Number.isInteger(maxReintentosNoEntendido) ? maxReintentosNoEntendido : null,
        appointmentStageKey === undefined ? null : appointmentStageKey,
        req.user.tenantId
      ]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Servicios ---

botRouter.get('/services', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nombre, duracion_minutos, permite_presencial, permite_virtual, activo, posicion
       FROM bot_services WHERE tenant_id = $1 ORDER BY posicion ASC`,
      [req.user.tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

botRouter.post('/services', requireRole('admin'), async (req, res) => {
  const { nombre, duracionMinutos, permitePresencial, permiteVirtual } = req.body || {};
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'nombre es obligatorio' });

  const presencial = typeof permitePresencial === 'boolean' ? permitePresencial : true;
  const virtual = typeof permiteVirtual === 'boolean' ? permiteVirtual : false;
  if (!presencial && !virtual) {
    return res.status(400).json({ error: 'El servicio debe aceptar presencial, virtual, o ambos' });
  }

  try {
    const maxPos = await pool.query(
      'SELECT COALESCE(MAX(posicion), -1) AS max_pos FROM bot_services WHERE tenant_id = $1',
      [req.user.tenantId]
    );
    const result = await pool.query(
      `INSERT INTO bot_services (tenant_id, nombre, duracion_minutos, permite_presencial, permite_virtual, posicion)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nombre, duracion_minutos, permite_presencial, permite_virtual, activo, posicion`,
      [req.user.tenantId, nombre.trim(), duracionMinutos || 30, presencial, virtual, maxPos.rows[0].max_pos + 1]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

botRouter.patch('/services/:id', requireRole('admin'), async (req, res) => {
  const { nombre, duracionMinutos, permitePresencial, permiteVirtual, activo } = req.body || {};

  try {
    const current = await pool.query('SELECT id FROM bot_services WHERE id = $1 AND tenant_id = $2', [
      req.params.id,
      req.user.tenantId
    ]);
    if (current.rowCount === 0) return res.status(404).json({ error: 'Servicio no encontrado' });

    const result = await pool.query(
      `UPDATE bot_services SET
         nombre = COALESCE($1, nombre),
         duracion_minutos = COALESCE($2, duracion_minutos),
         permite_presencial = COALESCE($3, permite_presencial),
         permite_virtual = COALESCE($4, permite_virtual),
         activo = COALESCE($5, activo)
       WHERE id = $6
       RETURNING id, nombre, duracion_minutos, permite_presencial, permite_virtual, activo, posicion`,
      [
        nombre && nombre.trim() ? nombre.trim() : null,
        duracionMinutos || null,
        typeof permitePresencial === 'boolean' ? permitePresencial : null,
        typeof permiteVirtual === 'boolean' ? permiteVirtual : null,
        typeof activo === 'boolean' ? activo : null,
        req.params.id
      ]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

botRouter.delete('/services/:id', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM bot_services WHERE id = $1 AND tenant_id = $2 RETURNING id', [
      req.params.id,
      req.user.tenantId
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Servicio no encontrado' });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- FAQs ---

botRouter.get('/faqs', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, pregunta, respuesta, activo FROM bot_faqs WHERE tenant_id = $1 ORDER BY created_at ASC',
      [req.user.tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

botRouter.post('/faqs', requireRole('admin'), async (req, res) => {
  const { pregunta, respuesta } = req.body || {};
  if (!pregunta || !pregunta.trim()) return res.status(400).json({ error: 'pregunta es obligatoria' });
  if (!respuesta || !respuesta.trim()) return res.status(400).json({ error: 'respuesta es obligatoria' });

  try {
    const result = await pool.query(
      `INSERT INTO bot_faqs (tenant_id, pregunta, respuesta) VALUES ($1, $2, $3)
       RETURNING id, pregunta, respuesta, activo`,
      [req.user.tenantId, pregunta.trim(), respuesta.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

botRouter.patch('/faqs/:id', requireRole('admin'), async (req, res) => {
  const { pregunta, respuesta, activo } = req.body || {};

  try {
    const current = await pool.query('SELECT id FROM bot_faqs WHERE id = $1 AND tenant_id = $2', [
      req.params.id,
      req.user.tenantId
    ]);
    if (current.rowCount === 0) return res.status(404).json({ error: 'Pregunta no encontrada' });

    const result = await pool.query(
      `UPDATE bot_faqs SET
         pregunta = COALESCE($1, pregunta),
         respuesta = COALESCE($2, respuesta),
         activo = COALESCE($3, activo)
       WHERE id = $4
       RETURNING id, pregunta, respuesta, activo`,
      [
        pregunta && pregunta.trim() ? pregunta.trim() : null,
        respuesta && respuesta.trim() ? respuesta.trim() : null,
        typeof activo === 'boolean' ? activo : null,
        req.params.id
      ]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

botRouter.delete('/faqs/:id', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM bot_faqs WHERE id = $1 AND tenant_id = $2 RETURNING id', [
      req.params.id,
      req.user.tenantId
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Pregunta no encontrada' });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Sedes ---

botRouter.get('/locations', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nombre, direccion, nota, horario_atencion, activo, posicion
       FROM bot_locations WHERE tenant_id = $1 ORDER BY posicion ASC`,
      [req.user.tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

botRouter.post('/locations', requireRole('admin'), async (req, res) => {
  const { nombre, direccion, nota, horarioAtencion } = req.body || {};
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'nombre es obligatorio' });

  try {
    const maxPos = await pool.query(
      'SELECT COALESCE(MAX(posicion), -1) AS max_pos FROM bot_locations WHERE tenant_id = $1',
      [req.user.tenantId]
    );
    const result = await pool.query(
      `INSERT INTO bot_locations (tenant_id, nombre, direccion, nota, horario_atencion, posicion)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nombre, direccion, nota, horario_atencion, activo, posicion`,
      [
        req.user.tenantId,
        nombre.trim(),
        direccion || null,
        nota || null,
        JSON.stringify(horarioAtencion || {}),
        maxPos.rows[0].max_pos + 1
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

botRouter.patch('/locations/:id', requireRole('admin'), async (req, res) => {
  const { nombre, direccion, nota, horarioAtencion, activo } = req.body || {};

  try {
    const current = await pool.query('SELECT id FROM bot_locations WHERE id = $1 AND tenant_id = $2', [
      req.params.id,
      req.user.tenantId
    ]);
    if (current.rowCount === 0) return res.status(404).json({ error: 'Sede no encontrada' });

    const result = await pool.query(
      `UPDATE bot_locations SET
         nombre = COALESCE($1, nombre),
         direccion = COALESCE($2, direccion),
         nota = COALESCE($3, nota),
         horario_atencion = COALESCE($4, horario_atencion),
         activo = COALESCE($5, activo)
       WHERE id = $6
       RETURNING id, nombre, direccion, nota, horario_atencion, activo, posicion`,
      [
        nombre && nombre.trim() ? nombre.trim() : null,
        direccion ?? null,
        nota ?? null,
        horarioAtencion ? JSON.stringify(horarioAtencion) : null,
        typeof activo === 'boolean' ? activo : null,
        req.params.id
      ]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

botRouter.delete('/locations/:id', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM bot_locations WHERE id = $1 AND tenant_id = $2 RETURNING id', [
      req.params.id,
      req.user.tenantId
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Sede no encontrada' });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
