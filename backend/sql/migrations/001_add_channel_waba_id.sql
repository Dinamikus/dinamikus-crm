-- Ejecutar solo si ya corriste schema.sql antes de esta fecha.
-- Bases nuevas: schema.sql ya incluye esta columna, no hace falta correr esto.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS external_waba_id TEXT;
