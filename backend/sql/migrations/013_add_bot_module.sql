-- Módulo de bot de agendamiento de citas, respuestas y seguimiento.
-- Un registro de configuración por negocio (bot_config), catálogos que ese
-- negocio administra (bot_services, bot_faqs), las citas en sí (appointments)
-- y el "paso actual" de cada conversación con el bot (bot_conversation_state).

CREATE TABLE IF NOT EXISTS bot_config (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  activo BOOLEAN NOT NULL DEFAULT false,
  nombre_negocio TEXT,
  direccion TEXT,
  -- horario_atencion: {"lunes": ["08:00","17:00"], "martes": [...], ...}
  -- un día ausente o con valor null significa que ese día no atiende.
  horario_atencion JSONB NOT NULL DEFAULT '{}'::jsonb,
  timezone TEXT NOT NULL DEFAULT 'America/El_Salvador',
  recordatorio_24h BOOLEAN NOT NULL DEFAULT true,
  recordatorio_2h BOOLEAN NOT NULL DEFAULT true,
  recontacto_no_show BOOLEAN NOT NULL DEFAULT true,
  dias_recontacto_no_show INT NOT NULL DEFAULT 2,
  max_reintentos_no_entendido INT NOT NULL DEFAULT 2,
  -- Si se configura, al confirmarse una cita el lead se mueve a esta etapa
  -- del pipeline del negocio (debe coincidir con una key existente en
  -- pipeline_stages de ese tenant). NULL = no mover de etapa automáticamente.
  appointment_stage_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  duracion_minutos INT NOT NULL DEFAULT 30,
  activo BOOLEAN NOT NULL DEFAULT true,
  posicion INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_services_tenant ON bot_services(tenant_id, posicion);

CREATE TABLE IF NOT EXISTS bot_faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pregunta TEXT NOT NULL,
  respuesta TEXT NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_faqs_tenant ON bot_faqs(tenant_id);

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  service_id UUID REFERENCES bot_services(id) ON DELETE SET NULL,
  fecha_hora TIMESTAMPTZ NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente','confirmada','cancelada','completada','no_show')),
  nombre_paciente TEXT,
  notas TEXT,
  recordatorio_24h_enviado BOOLEAN NOT NULL DEFAULT false,
  recordatorio_2h_enviado BOOLEAN NOT NULL DEFAULT false,
  recontacto_enviado BOOLEAN NOT NULL DEFAULT false,
  creado_por TEXT NOT NULL DEFAULT 'bot' CHECK (creado_por IN ('bot','asesor')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_tenant_fecha ON appointments(tenant_id, fecha_hora);
CREATE INDEX IF NOT EXISTS idx_appointments_lead ON appointments(lead_id);

-- Un registro por conversación: "dónde va" el flujo del bot con ese lead.
CREATE TABLE IF NOT EXISTS bot_conversation_state (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  paso_actual TEXT NOT NULL DEFAULT 'inicio',
  datos_recolectados JSONB NOT NULL DEFAULT '{}'::jsonb,
  intentos_no_entendido INT NOT NULL DEFAULT 0,
  -- true cuando un asesor tomó el control de la conversación desde el Inbox.
  bot_pausado BOOLEAN NOT NULL DEFAULT false,
  pausado_hasta TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
