-- Ejecutar solo si ya corriste schema.sql antes de esta fecha.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_key TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime_type TEXT;
