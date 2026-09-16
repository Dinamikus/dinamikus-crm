-- Sedes de un negocio (ej. dos clínicas donde el Dr. rota). El horario de
-- atención vive AQUÍ, por sede, no en bot_config — porque la disponibilidad
-- cambia según dónde esté el doctor ese día.
CREATE TABLE IF NOT EXISTS bot_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  direccion TEXT,
  nota TEXT,
  -- Mismo formato que bot_config.horario_atencion: {"lunes": ["08:00","17:00"], ...}
  horario_atencion JSONB NOT NULL DEFAULT '{}'::jsonb,
  activo BOOLEAN NOT NULL DEFAULT true,
  posicion INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_locations_tenant ON bot_locations(tenant_id, posicion);

-- Negocios que NO configuran ninguna sede siguen funcionando igual que antes
-- (usan bot_config.horario_atencion como único horario, sin pedir ubicación).
-- bot_config.horario_atencion pasa a ser también el horario para citas
-- virtuales (que no están atadas a ninguna sede física).

-- Un servicio puede ofrecerse presencial, virtual, o ambos.
ALTER TABLE bot_services ADD COLUMN IF NOT EXISTS permite_presencial BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE bot_services ADD COLUMN IF NOT EXISTS permite_virtual BOOLEAN NOT NULL DEFAULT false;

-- Cada cita queda marcada con su modalidad y, si es presencial, su sede.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS modalidad TEXT CHECK (modalidad IN ('presencial','virtual'));
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES bot_locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_location_fecha ON appointments(location_id, fecha_hora);
