-- Ejecutar solo si ya corriste schema.sql antes de esta fecha.
-- Bases nuevas: schema.sql ya incluye este índice, no hace falta correr esto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_tenant_channel_external
  ON leads(tenant_id, channel_id, external_user_id) WHERE external_user_id IS NOT NULL AND phone IS NULL;
