-- Ejecutar solo si ya corriste schema.sql antes de esta fecha.
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_closed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_tenant ON pipeline_stages(tenant_id, position);

-- Siembra las 6 etapas que ya existían (fijas en el código) para cada negocio
-- que ya estaba registrado antes de esta migración — así ningún lead existente
-- queda "huérfano" de una etapa reconocida.
INSERT INTO pipeline_stages (tenant_id, key, label, position, is_default, is_closed)
SELECT t.id, s.key, s.label, s.position, s.is_default, s.is_closed
FROM tenants t
CROSS JOIN (VALUES
  ('new', 'Nuevo', 0, true, false),
  ('contacted', 'En conversación', 1, false, false),
  ('follow_up', 'Recontacto', 2, false, false),
  ('appointment', 'Cita', 3, false, false),
  ('won', 'Cierre', 4, false, true),
  ('not_interested', 'No le interesa', 5, false, true)
) AS s(key, label, position, is_default, is_closed)
ON CONFLICT (tenant_id, key) DO NOTHING;
