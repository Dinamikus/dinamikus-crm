# CRM SaaS Meta MVP

MVP inicial de un CRM SaaS multiempresa orientado a leads provenientes de WhatsApp, Instagram y Facebook.

## Arquitectura
- Frontend: HTML + CSS + JavaScript vanilla.
- Backend: Node.js + Express.
- Base de datos: PostgreSQL.
- WhatsApp: Meta WhatsApp Business Platform / Cloud API mediante Graph API + Webhooks.
- Multiempresa: cada `tenant` tiene sus propios usuarios, canales y leads.

## Importante
Este proyecto es un esqueleto funcional para comenzar el desarrollo. No contiene credenciales de Meta ni datos reales.

## 1. Preparar backend

```bash
cd backend
npm install
cp .env.example .env
```

Configura PostgreSQL y ejecuta:

```bash
psql "$DATABASE_URL" -f sql/schema.sql
npm run dev
```

## 2. Configurar frontend

El backend sirve el frontend automáticamente en `/`.

## 3. WhatsApp Cloud API

En Meta for Developers:
1. Crear una app de negocio.
2. Configurar WhatsApp Business Platform.
3. Obtener el Phone Number ID y token.
4. Configurar un webhook HTTPS.
5. Suscribir el webhook al campo `messages`.

El endpoint del MVP es:

`GET /api/webhooks/whatsapp` para verificación.

`POST /api/webhooks/whatsapp` para recibir eventos.

Las variables de entorno controlan la versión de Graph API, por lo que no se fija una versión obsoleta dentro del código.

## Autenticación
- `POST /api/auth/register` crea un negocio (tenant) + su usuario admin.
- `POST /api/auth/login` devuelve un JWT (7 días de expiración).
- Rutas protegidas requieren `Authorization: Bearer <token>`.
- Frontend: `/login.html` y `/register.html`; `frontend/auth.js` maneja la sesión (localStorage) y redirige si no hay token.

## Canales
- `GET/POST/DELETE /api/channels` — listado y borrado de canales del tenant.
- `POST /api/channels/whatsapp/embedded-signup` — flujo recomendado: el negocio conecta su WhatsApp con un clic desde `/channels.html`, sin que nadie tenga que copiar el Phone Number ID a mano.
- `POST /api/channels` — registro manual (respaldo, solo si el Embedded Signup aún no está configurado en tu app de Meta).
- Los tokens de Meta se guardan cifrados (AES-256-GCM, `backend/src/crypto.js`) en `channels.access_token_encrypted`.

### Configuración previa en Meta (requisito para el Embedded Signup — no es código, es panel de Meta)
Esto **no lo puedo hacer por ti** porque requiere tu cuenta de Meta Business:
1. Crear una app tipo "Business" en [Meta for Developers](https://developers.facebook.com/apps), agregar el producto WhatsApp.
2. Aplicar a **Solution Partner** o **Tech Provider** (Dinamikus conectará WhatsApp de negocios de terceros, así que necesitas uno de estos dos estatus).
3. En **Facebook Login for Business > Settings**, habilitar Client OAuth login, Web OAuth login, Enforce HTTPS y "Login with the JavaScript SDK"; agregar tu dominio en *Allowed domains* y *Valid OAuth redirect URIs* (HTTPS obligatorio).
4. En **Facebook Login for Business > Configurations**, crear una configuración desde la plantilla "WhatsApp Embedded Signup" — de ahí sacas el **Configuration ID**.
5. Copiar App ID, App Secret y Configuration ID a tu `.env` (`META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`) y generar `ENCRYPTION_KEY` con:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
6. Suscribirte al webhook `account_update` en tu app (Meta lo dispara cuando un cliente termina el flujo).

Mientras no completes esto, `/channels.html` muestra automáticamente el formulario de registro manual como respaldo.

**Nota:** Embedded Signup v2 se descontinúa el 15 de octubre de 2026 — esta implementación ya usa v4, así que no tienes que migrar nada más adelante.

## Instagram Messaging
- `POST /api/webhooks/instagram` (y su verificación GET) — procesa mensajes de Instagram Direct. Estructura de payload distinta a WhatsApp (`entry[].messaging[]`, estilo Messenger) — ver `backend/src/instagram.js`.
- Filtra automáticamente los eco de tus propios mensajes salientes (Meta los reenvía por el mismo webhook con `is_echo: true`) para no duplicarlos.
- Los leads de Instagram no tienen teléfono — se identifican por `(tenant, canal, Instagram-scoped ID)`.
- **Todavía no hay Embedded Signup para Instagram** (solo lo construimos para WhatsApp). Para conectar una cuenta, usa el formulario manual en `/channels.html`: pega el **Instagram Account ID** y un **access token** — sin el token, el canal recibe mensajes pero no puede responder.
- El envío ahora vive en un endpoint único, **`POST /api/messages/send`** (reemplaza a `/api/whatsapp/send`), que enruta a WhatsApp o Instagram según el canal del lead.

### Cómo conseguir el Instagram Account ID y el access token (manual, mientras no haya Embedded Signup)
1. La cuenta de Instagram debe ser profesional (Business o Creator) y estar vinculada a una Página de Facebook, o usar Instagram API with Instagram Login directamente.
2. En Graph API Explorer o vía `GET /me/accounts`, obtén el Instagram Account ID (`instagram_business_account`) y genera un token con los permisos `instagram_basic`, `instagram_manage_messages`, `pages_messaging`.
3. Suscribe tu app al webhook `messages` bajo el producto **Instagram** en el dashboard de tu app de Meta.

## Webhook de WhatsApp — ya procesa mensajes reales
`backend/src/whatsapp.js` resuelve el tenant a partir de `metadata.phone_number_id`, hace upsert del lead por `(tenant_id, phone)`, reutiliza la conversación abierta o crea una nueva, y guarda cada mensaje de forma idempotente (por `external_message_id`). Mensajes de un `phone_number_id` no registrado se descartan con un log de advertencia.

## Inbox
- `GET /api/conversations` — lista conversaciones del tenant con último mensaje, ordenadas por actividad reciente, mezclando WhatsApp e Instagram. Filtros: `?channelId=`, `?assignedUserId=`, `?unassigned=true`, `?status=`.
- `GET /api/conversations/:id/messages` — hilo completo de una conversación.
- `GET /api/leads` y `PATCH /api/leads/:id` — listado (con los mismos filtros) y cambio de estado/asignación del lead.
- Frontend: `/inbox.html` — lista de conversaciones + hilo tipo chat + respuesta, con refresco automático cada 15s.

## Reparto de leads entre asesores (varios números de WhatsApp por negocio)
Modelo híbrido: **un solo inbox** para todo el negocio, sin importar cuántos números de WhatsApp o cuentas de Instagram tenga conectados — cada canal es solo una fila más en `channels`, no hace falta ningún cambio para conectar 2, 3 o más.
- `GET /api/users` — lista de asesores del tenant (para poblar selectores de asignación).
- `GET/PATCH /api/tenant/settings` — activa/desactiva el reparto automático (`auto_assign_leads`). Se controla también desde el switch en `/inbox.html`.
- **Reparto automático** (`backend/src/assignment.js`): cuando está activo, cada lead **nuevo** (no cada mensaje) se asigna al asesor con menos leads activos en ese momento — balanceo por carga, no por turno fijo. Se dispara desde `whatsapp.js` e `instagram.js` justo después de crear el lead (usa el truco `xmax = 0` de Postgres para distinguir un INSERT real de un UPDATE por upsert).
- **Asignación manual**: `PATCH /api/leads/:id` con `{ "assignedUserId": "<uuid>" }` (o `null` para desasignar) — también disponible desde el selector en el encabezado de cada conversación en el inbox.
- **Filtros en el inbox**: por canal (ver solo el número de un asesor específico) y por asesor asignado / sin asignar — así cubres tanto "quiero ver todo" como "quiero ver solo lo mío" sin necesitar paneles separados.
- Los roles (`admin`/`agent`) siguen sin restringir visibilidad todavía — cualquier usuario del tenant puede ver y filtrar el inbox completo. Si más adelante quieres que un `agent` solo pueda ver sus propios leads (no los de sus compañeros), es un cambio pequeño sobre esta misma base.

## Equipo (crear asesores, activar/desactivar, resetear contraseña)
- `GET /api/users?active=true` — lista de asesores del tenant (el filtro `active=true` es para poblar selectores de asignación; sin filtro, trae también a los inactivos, para la pantalla de gestión).
- `POST /api/users` (solo admin) — crea un asesor con nombre, correo, rol y **la contraseña que tú definas** — pensado para que generes las credenciales y se las entregues directamente, sin flujo de invitación por correo.
- `PATCH /api/users/:id` (solo admin) — activar/desactivar (`isActive`), cambiar rol, o resetear la contraseña (`password`). Un admin no puede desactivarse a sí mismo (evita quedarte fuera por accidente).
- **Desactivar, no borrar**: por la rotación de personal, cuando alguien se va desactivas su cuenta en vez de eliminarla — sus leads, conversaciones y mensajes quedan intactos para consultar el historial, y ya no puede iniciar sesión.
- La desactivación es **inmediata**: si el asesor tenía una sesión abierta, su token deja de funcionar en la siguiente petición, no hasta que expire (7 días).
- El reparto automático de leads (ver sección de reparto arriba) excluye a los asesores inactivos.
- Frontend: `/team.html` — crear asesores con un botón de "Generar" contraseña segura, activar/desactivar, y resetear contraseña (la muestra una sola vez para copiarla).

## Visibilidad por rol (admin ve todo, agent solo lo suyo)
- Un **admin** ve y filtra todas las conversaciones/leads del negocio, sin restricción.
- Un **agent** solo ve las conversaciones y leads con `assigned_user_id` igual al suyo — aplica en `GET /api/conversations`, `GET /api/conversations/:id/messages`, `GET /api/leads`, `PATCH /api/leads/:id` y `POST /api/messages/send`. Cualquier filtro que mande en la URL (`assignedUserId`, `unassigned`) se ignora si es un `agent` — no puede ver leads ajenos manipulando la petición.
- Intentar acceder a una conversación o lead que no es suyo devuelve **404** (no 403) — así no confirma que existe algo ajeno con ese id.
- Un `agent` puede cambiar el estado/notas de sus propios leads y responder sus propias conversaciones, pero **no puede reasignar** ningún lead (ni el suyo a otra persona) — eso sigue siendo exclusivo del `admin` (403 si lo intenta).
- El frontend (`/inbox.html`) oculta el selector de "asignar a" y el filtro por asesor cuando quien entra no es admin, ya que no aplican.

## Automatizaciones
**Mensaje de bienvenida automático**: cuando un lead escribe por primera vez (WhatsApp o Instagram), si está activado, se le responde solo — antes de que cualquier asesor lo vea — con un texto configurable. Solo se dispara una vez, en el mensaje que crea el lead (no en cada mensaje siguiente); usa el mismo truco `xmax = 0` que el reparto automático para distinguir "lead nuevo" de "mensaje de alguien que ya existía".
- `backend/src/automations.js` — la lógica de envío, reutiliza `sendWhatsAppText`/`sendInstagramText` y las credenciales propias del canal (o el respaldo global de WhatsApp si el canal no tiene token). El mensaje enviado queda guardado en la conversación como un mensaje saliente más, igual que si lo hubiera escrito un asesor.
- Un fallo al enviar (red, credenciales inválidas) se registra en el log pero **nunca** tumba el procesamiento del webhook — el lead y su mensaje ya quedaron guardados de cualquier forma.
- `GET/PATCH /api/tenant/settings` ahora también incluye `welcome_message_enabled` y `welcome_message`. **El PATCH quedó restringido a `admin`** (antes cualquier usuario autenticado podía cambiar la configuración del negocio — se cerró ese hueco de paso).
- Frontend: `/automations.html` — activar/desactivar y editar el texto; de solo lectura para quien no sea admin.

## Reportes por asesor (métricas con rango de fechas)
- `GET /api/reports/advisors?from=YYYY-MM-DD&to=YYYY-MM-DD` (solo admin) — por cada asesor, cuenta los leads **recibidos en ese rango** (por fecha de creación del lead) y los desglosa en: en conversación / sin respuesta (según si ya tiene al menos un mensaje saliente), recontacto, citas, cierres, y no le interesa (estos últimos cuatro son el estado **actual** del lead, no llevamos historial de cambios de estado todavía). Incluye una fila de leads sin asignar.
- Frontend: `/reports.html` — selector de fechas (por defecto, últimos 10 días) + tabla con fila de totales. Solo visible/funcional para admin.

### Estados del pipeline (actualizados en esta fase)
Se reemplazaron `interested`/`lost` por una taxonomía más cercana a como se trabaja de verdad: `new` (nuevo), `contacted` (en conversación), `follow_up` (recontacto), `appointment` (cita), `won` (cierre), `not_interested` (no le interesa). Si ya tenías datos con los estados viejos, actualízalos a mano con un `UPDATE leads SET status = ...` antes de usar los reportes.

## Roles: admin, supervisor, agent
- **admin**: acceso total — configuración del negocio, canales, equipo, reportes, y opera cualquier lead sin restricción.
- **supervisor**: ve **todo** el inbox/leads del negocio (no está limitado a leads propios, porque no opera leads) y **puede reasignarlos** entre asesores — su única función es repartir/quitar trabajo, no ejecutarlo. No puede cambiar el estado ni las notas de un lead (403 si lo intenta), no puede enviar mensajes (403), y no puede tocar nada de configuración: ni equipo, ni canales, ni ajustes del tenant, ni automatizaciones (todo eso sigue siendo exclusivo de `admin`). Si puede ver reportes (`GET /api/reports/advisors`).
- **agent**: solo ve y opera (estado/notas/respuestas) sus propios leads asignados; nunca puede reasignar, ni ver reportes de equipo, ni tocar configuración.
- Los supervisores quedan **excluidos del reparto automático de leads** — no trabajan leads, no deben recibir ninguno (verificado: con reparto automático activo, los leads nuevos solo cayeron entre `admin` y `agent`, nunca en un `supervisor`).
- De paso se cerró un hueco que existía desde antes: crear/eliminar **canales** no tenía ninguna restricción de rol — cualquier usuario autenticado podía conectar o quitar un número de WhatsApp/Instagram. Ya quedó restringido a `admin`.

## Base de datos — migraciones
Si ya corriste `schema.sql` antes de estas fases, aplica en orden:
```
psql "$DATABASE_URL" -f sql/migrations/001_add_channel_waba_id.sql
psql "$DATABASE_URL" -f sql/migrations/002_add_leads_instagram_unique_index.sql
psql "$DATABASE_URL" -f sql/migrations/003_add_tenant_auto_assign.sql
psql "$DATABASE_URL" -f sql/migrations/004_add_users_is_active.sql
psql "$DATABASE_URL" -f sql/migrations/005_add_tenant_welcome_message.sql
psql "$DATABASE_URL" -f sql/migrations/006_add_supervisor_role.sql
```
Bases de datos nuevas no necesitan esto — `schema.sql` ya incluye los seis cambios.

## Próximas fases
1. ~~Autenticación real y roles.~~ ✅
2. ~~Alta de empresas/tenants.~~ ✅
3. ~~OAuth/Embedded Signup de Meta para conectar cuentas de clientes.~~ ✅ (solo WhatsApp — ver sección Canales arriba)
4. ~~Inbox unificado.~~ ✅
5. ~~Instagram Messaging.~~ ✅ (conexión manual — falta su propio Embedded Signup)
6. ~~Reparto de leads entre asesores (híbrido: manual + automático + filtros).~~ ✅
7. ~~Gestión de equipo (crear/activar/desactivar asesores).~~ ✅
8. ~~Restringir visibilidad del inbox por rol.~~ ✅
9. ~~Automatización: mensaje de bienvenida a leads nuevos.~~ ✅
10. ~~Reportes por asesor con rango de fechas.~~ ✅
11. ~~Rol supervisor (ve todo, reasigna leads, sin acceso a configuración).~~ ✅
12. Automatizaciones futuras: horario de atención, respuestas por palabra clave, seguimiento automático a leads sin respuesta.
13. Historial de cambios de estado (para que los reportes reflejen el estado que tenía el lead en cada fecha, no solo el actual).
14. Plantillas y seguimiento de WhatsApp.
8. Facturación SaaS.
9. Auditoría, rate limits y observabilidad. ~~Encriptar `access_token_encrypted`.~~ ✅
