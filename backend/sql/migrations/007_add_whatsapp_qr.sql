-- Ejecutar solo si ya corriste schema.sql antes de esta fecha.
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check
  CHECK (type IN ('whatsapp','instagram','messenger','whatsapp_qr'));
ALTER TABLE channels ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_channels_owner ON channels(owner_user_id);

CREATE TABLE IF NOT EXISTS whatsapp_qr_sessions (
  channel_id UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  auth_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
