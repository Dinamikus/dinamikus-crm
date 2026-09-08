import { Router } from 'express';
import { pool } from './db.js';
import { requireAuth, requireRole } from './auth.js';

export const teamsRouter = Router();
teamsRouter.use(requireAuth);

// GET /api/teams — cualquier usuario puede ver la lista de equipos (informativo,
// como el directorio de "Equipo"), con el nombre del supervisor y cuántos
// asesores tiene cada uno.
teamsRouter.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.name, t.supervisor_id, s.name AS supervisor_name,
              COUNT(u.id)::int AS member_count
       FROM teams t
       LEFT JOIN users s ON s.id = t.supervisor_id
       LEFT JOIN users u ON u.team_id = t.id
       WHERE t.tenant_id = $1
       GROUP BY t.id, s.name
       ORDER BY t.name ASC`,
      [req.user.tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/teams — crear un equipo (solo admin).
teamsRouter.post('/', requireRole('admin'), async (req, res) => {
  const { name, supervisorId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  try {
    if (supervisorId) {
      const sup = await pool.query(
        "SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND role = 'supervisor'",
        [supervisorId, req.user.tenantId]
      );
      if (sup.rowCount === 0) {
        return res.status(400).json({ error: 'supervisorId debe ser un usuario con rol supervisor de este negocio' });
      }
    }

    const result = await pool.query(
      `INSERT INTO teams (tenant_id, name, supervisor_id) VALUES ($1, $2, $3)
       RETURNING id, name, supervisor_id`,
      [req.user.tenantId, name.trim(), supervisorId || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/teams/:id — renombrar o cambiar el supervisor de un equipo (solo admin).
teamsRouter.patch('/:id', requireRole('admin'), async (req, res) => {
  const { name, supervisorId } = req.body || {};
  const touchesSupervisor = Object.prototype.hasOwnProperty.call(req.body || {}, 'supervisorId');

  try {
    if (touchesSupervisor && supervisorId) {
      const sup = await pool.query(
        "SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND role = 'supervisor'",
        [supervisorId, req.user.tenantId]
      );
      if (sup.rowCount === 0) {
        return res.status(400).json({ error: 'supervisorId debe ser un usuario con rol supervisor de este negocio' });
      }
    }

    const setClauses = ['name = COALESCE($1, name)'];
    const params = [name ? name.trim() : null];
    if (touchesSupervisor) {
      params.push(supervisorId || null);
      setClauses.push(`supervisor_id = $${params.length}`);
    }
    params.push(req.params.id, req.user.tenantId);

    const result = await pool.query(
      `UPDATE teams SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING id, name, supervisor_id`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Team not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/teams/:id — elimina el equipo (solo admin). Sus asesores quedan
// sin equipo (team_id = NULL), no se borran ni se tocan sus leads.
teamsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM teams WHERE id = $1 AND tenant_id = $2 RETURNING id', [
      req.params.id,
      req.user.tenantId
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Team not found' });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
