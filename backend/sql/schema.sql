CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  auto_assign_leads BOOLEAN NOT NULL DEFAULT false,
  welcome_message_enabled BOOLEAN NOT NULL DEFAULT false,
  welcome_message TEXT NOT NULL DEFAULT 'Gracias por escribirnos. En breve un asesor te atiende.',
  -- Pausar un negocio completo (ej. dejó de pagar / dejó de trabajar contigo).
  -- A diferencia de users.is_active (que pausa UN usuario), esto bloquea a
  -- TODOS los usuarios de ese negocio a la vez, sin borrar nada.
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','supervisor','agent')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- Dueño de la plataforma (tú, Dinamikus) — ve y gestiona TODOS los negocios,
  -- no solo el suyo. Nunca se activa por registro normal ni por ningún endpoint;
  -- solo se otorga a mano, directo en la base de datos, una vez.
  is_platform_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

-- Equipos: agrupan asesores bajo un supervisor. Un supervisor solo ve/gestiona
-- los leads de los asesores de SU equipo — nunca los de otro supervisor.
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  supervisor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teams_tenant ON teams(tenant_id);
CREATE INDEX IF NOT EXISTS idx_teams_supervisor ON teams(supervisor_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('whatsapp','instagram','messenger','whatsapp_qr')),
  external_id TEXT,
  external_waba_id TEXT,
  display_name TEXT,
  access_token_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  -- Dueño del canal cuando es personal (un asesor conecta su propio WhatsApp por QR).
  -- NULL para canales del negocio en general (WhatsApp Cloud API, Instagram).
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channels_owner ON channels(owner_user_id);

-- Guarda las credenciales de sesión de Baileys (WhatsApp Web) por canal, para que
-- sobreviva un redeploy sin tener que volver a escanear el QR. No usamos el sistema
-- de archivos del contenedor (es efímero en Railway) — todo vive en Postgres.
CREATE TABLE IF NOT EXISTS whatsapp_qr_sessions (
  channel_id UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  auth_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un external_id (p. ej. phone_number_id de Meta) identifica un único canal en todo el sistema;
-- es lo que permite al webhook resolver a qué tenant pertenece un mensaje entrante.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_type_external
  ON channels(type, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT,
  phone TEXT,
  external_user_id TEXT,
  source TEXT NOT NULL,
  service_interest TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Etapas del embudo de ventas (pipeline), personalizables por negocio — cada
-- tenant tiene las suyas, distintas a las de cualquier otro. "leads.status"
-- guarda la "key" de la etapa (texto libre, no una lista fija en la base de datos).
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  -- La etapa en la que arranca un lead nuevo (debe haber exactamente una marcada así).
  is_default BOOLEAN NOT NULL DEFAULT false,
  -- Etapas "cerradas" (ej. Cierre, No le interesa): no cuentan como carga de
  -- trabajo activa de un asesor para el reparto automático, y no se consideran
  -- "leads abiertos" en el dashboard.
  is_closed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_tenant ON pipeline_stages(tenant_id, position);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  external_conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  external_message_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_external_id TEXT,
  message_type TEXT,
  body TEXT,
  -- Referencia al archivo en el bucket de almacenamiento (no la URL directa, que
  -- expira o no es de acceso público) — NULL para mensajes de solo texto.
  media_key TEXT,
  media_mime_type TEXT,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_tenant_phone
  ON leads(tenant_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_tenant_channel_external
  ON leads(tenant_id, channel_id, external_user_id) WHERE external_user_id IS NOT NULL AND phone IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_external ON messages(external_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_unique
  ON messages(conversation_id, external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_lead_status ON conversations(lead_id, status);
