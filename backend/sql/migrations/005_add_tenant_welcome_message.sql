-- Ejecutar solo si ya corriste schema.sql antes de esta fecha.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS welcome_message_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS welcome_message TEXT NOT NULL DEFAULT 'Gracias por escribirnos. En breve un asesor te atiende.';
