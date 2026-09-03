-- Ejecutar solo si ya corriste schema.sql antes de esta fecha.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auto_assign_leads BOOLEAN NOT NULL DEFAULT false;
