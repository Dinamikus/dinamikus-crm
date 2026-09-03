-- Ejecutar solo si ya corriste schema.sql antes de esta fecha.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
