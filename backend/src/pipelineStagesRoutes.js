import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth, requireRole } from './auth.js';

export const pipelineStagesRouter = Router();
pipelineStagesRouter.use(requireAuth);

// GET /api/pipeline-stages — cualquier usuario autenticado (se necesita para
// pintar el Pipeline, los selectores de estado, los reportes, etc).
pipelineStagesRouter.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, key, label, position, is_default, is_closed
       FROM pipeline_stages WHERE tenant_id = $1 ORDER BY position ASC`,
      [req.user.tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/pipeline-stages — crear una etapa nueva (solo admin).
pipelineStagesRouter.post('/', requireRole('admin'), async (req, res) => {
  const { label } = req.body || {};
  if (!label || !label.trim()) return res.status(400).json({ error: 'label es obligatorio' });

  try {
    const key = await uniqueKeyForLabel(req.user.tenantId, label);
    const maxPos = await pool.query(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM pipeline_stages WHERE tenant_id = $1',
      [req.user.tenantId]
    );
    const result = await pool.query(
      `INSERT INTO pipeline_stages (tenant_id, key, label, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, key, label, position, is_default, is_closed`,
      [req.user.tenantId, key, label.trim(), maxPos.rows[0].max_pos + 1]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/pipeline-stages/:id — renombrar, marcar como cerrada/por defecto,
// o mover un lugar arriba/abajo en el orden (solo admin).
pipelineStagesRouter.patch('/:id', requireRole('admin'), async (req, res) => {
  const { label, isClosed, isDefault, move } = req.body || {};

  try {
    const current = await pool.query(
      'SELECT id, position FROM pipeline_stages WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.user.tenantId]
    );
    if (current.rowCount === 0) return res.status(404).json({ error: 'Stage not found' });

    if (move === 'up' || move === 'down') {
      // Encuentra el vecino inmediato (la etapa justo antes o justo después en orden)
      // e intercambia sus posiciones.
      const all = await pool.query(
        'SELECT id, position FROM pipeline_stages WHERE tenant_id = $1 ORDER BY position ASC',
        [req.user.tenantId]
      );
      const idx = all.rows.findIndex((s) => s.id === req.params.id);
      const swapIdx = move === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= all.rows.length) {
        return res.status(400).json({ error: 'No se puede mover más en esa dirección' });
      }
      const a = all.rows[idx];
      const b = all.rows[swapIdx];
      await pool.query('UPDATE pipeline_stages SET position = $1 WHERE id = $2', [b.position, a.id]);
      await pool.query('UPDATE pipeline_stages SET position = $1 WHERE id = $2', [a.position, b.id]);
    }

    if (typeof isDefault === 'boolean' && isDefault) {
      // Solo puede haber una etapa "por defecto" a la vez.
      await pool.query('UPDATE pipeline_stages SET is_default = false WHERE tenant_id = $1', [
        req.user.tenantId
      ]);
    }

    const setClauses = [];
    const params = [];
    if (label && label.trim()) {
      params.push(label.trim());
      setClauses.push(`label = $${params.length}`);
    }
    if (typeof isClosed === 'boolean') {
      params.push(isClosed);
      setClauses.push(`is_closed = $${params.length}`);
    }
    if (typeof isDefault === 'boolean') {
      params.push(isDefault);
      setClauses.push(`is_default = $${params.length}`);
    }

    if (setClauses.length > 0) {
      params.push(req.params.id, req.user.tenantId);
      await pool.query(
        `UPDATE pipeline_stages SET ${setClauses.join(', ')}
         WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`,
        params
      );
    }

    const updated = await pool.query(
      'SELECT id, key, label, position, is_default, is_closed FROM pipeline_stages WHERE id = $1',
      [req.params.id]
    );
    res.json(updated.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/pipeline-stages/:id — borrar una etapa (solo admin). No se puede
// borrar si tiene leads adentro (hay que moverlos primero), ni la última etapa
// que quede, ni la etapa marcada como "por defecto" sin antes elegir otra.
pipelineStagesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const stage = await pool.query(
      'SELECT key, is_default FROM pipeline_stages WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.user.tenantId]
    );
    if (stage.rowCount === 0) return res.status(404).json({ error: 'Stage not found' });

    const totalStages = await pool.query(
      'SELECT COUNT(*)::int AS count FROM pipeline_stages WHERE tenant_id = $1',
      [req.user.tenantId]
    );
    if (totalStages.rows[0].count <= 1) {
      return res.status(400).json({ error: 'Debe quedar al menos una etapa en el pipeline' });
    }
    if (stage.rows[0].is_default) {
      return res.status(400).json({
        error: 'No puedes borrar la etapa por defecto — marca otra como "por defecto" primero'
      });
    }

    const leadsInStage = await pool.query(
      'SELECT COUNT(*)::int AS count FROM leads WHERE tenant_id = $1 AND status = $2',
      [req.user.tenantId, stage.rows[0].key]
    );
    if (leadsInStage.rows[0].count > 0) {
      return res.status(409).json({
        error: `Hay ${leadsInStage.rows[0].count} lead(s) en esta etapa — muévelos a otra etapa antes de borrarla`
      });
    }

    await pool.query('DELETE FROM pipeline_stages WHERE id = $1', [req.params.id]);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function slugify(text) {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'etapa';
}

async function uniqueKeyForLabel(tenantId, label) {
  const base = slugify(label);
  let key = base;
  let suffix = 2;
  while (true) {
    const exists = await pool.query(
      'SELECT id FROM pipeline_stages WHERE tenant_id = $1 AND key = $2',
      [tenantId, key]
    );
    if (exists.rowCount === 0) return key;
    key = `${base}_${suffix}`;
    suffix++;
  }
}
