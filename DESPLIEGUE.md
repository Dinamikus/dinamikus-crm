# Cómo poner el CRM en línea (Railway) — guía sin código

Esta guía asume que no programas. Todo se hace con clics en páginas web. Te toma
unos 15-20 minutos la primera vez.

## Lo que necesitas antes de empezar
- Una cuenta de [GitHub](https://github.com) (gratis) — ahí sube el código.
- Una cuenta de [Railway](https://railway.app) (gratis para empezar) — inicia sesión
  con tu cuenta de GitHub, así no creas otra contraseña.

---

## Paso 1 — Subir el código a GitHub

1. Entra a [github.com/new](https://github.com/new) y crea un repositorio nuevo.
   Nómbralo, por ejemplo, `dinamikus-crm`. Déjalo **privado** (este código tiene
   la lógica de tu producto). No marques ninguna otra opción, solo dale "Create repository".
2. En la página que aparece, busca el enlace **"uploading an existing file"**.
3. Descomprime el zip que te compartí en tu computadora. Vas a ver dos carpetas:
   `backend` y `frontend`, más algunos archivos sueltos (`README.md`, `package.json`).
4. Arrastra **todo el contenido de la carpeta descomprimida** (las carpetas `backend`
   y `frontend` completas, y los archivos sueltos) a esa página de GitHub.
5. Espera que termine de subir y dale "Commit changes".

No necesitas instalar nada en tu computadora para este paso — todo pasa en el navegador.

---

## Paso 2 — Crear el proyecto en Railway

1. Entra a [railway.app](https://railway.app) e inicia sesión con GitHub.
2. Dale **"New Project" → "Deploy from GitHub repo"**.
3. Elige el repositorio `dinamikus-crm` que acabas de subir.
4. Railway va a intentar arrancarlo automáticamente — **va a fallar la primera vez**,
   eso es normal, todavía falta la base de datos y las variables (siguientes pasos).

---

## Paso 3 — Agregar la base de datos

1. Dentro del mismo proyecto en Railway, dale **"+ New" → "Database" → "Add PostgreSQL"**.
2. Railway crea la base de datos sola, sin que configures nada.
3. Click en el servicio de tu app (el que se llama como tu repo, no el de Postgres) →
   pestaña **"Variables"** → **"+ New Variable"** → elige la opción de **referencia**
   (un ícono de enlace) → selecciona `DATABASE_URL` del servicio Postgres. Esto conecta
   tu app a la base de datos sin que copies ningún texto largo a mano.

---

## Paso 4 — Configurar las variables de entorno

En la misma pestaña **"Variables"** del servicio de tu app, agrega estas una por una
(botón "+ New Variable", nombre y valor):

| Nombre | Valor |
|---|---|
| `PGSSL` | `true` |
| `JWT_SECRET` | `dd02adcf0511dcdbea0f51d624fd57979420df818885070993dc96c83850249855357e033e231a35e2b705675eb626e4` |
| `ENCRYPTION_KEY` | `b00cc3152a0c5d8c133a9922172907b5697e90ea3716addd88cd7376e7f09ba2` |
| `META_VERIFY_TOKEN` | `dinamikus-verify-2026` (o cualquier palabra que inventes) |
| `META_GRAPH_VERSION` | `v21.0` |

Los valores de `JWT_SECRET` y `ENCRYPTION_KEY` de la tabla ya están generados y son
seguros para usar — cópialos tal cual. No los compartas fuera de tu equipo.

Las variables de Meta (`META_APP_ID`, `META_APP_SECRET`, `META_ACCESS_TOKEN`, etc.)
las agregas después, cuando tengas tu app de Meta lista — el sitio funciona sin
ellas, solo que el botón de "Conectar con Facebook" no aparecerá todavía hasta que
las agregues.

Railway va a reiniciar tu app solo cada vez que guardas una variable nueva.

---

## Paso 5 — Crear las tablas en la base de datos

1. Click en el servicio **Postgres** dentro de tu proyecto de Railway.
2. Busca la pestaña **"Data"** (o "Query").
3. Abre en tu computadora el archivo `backend/sql/schema.sql` (con el Bloc de notas,
   TextEdit, o cualquier editor de texto — no necesitas nada especial).
4. Copia **todo** el contenido y pégalo en el cuadro de la pestaña "Data"/"Query" de Railway.
5. Ejecútalo (botón "Run" o similar). Deberías ver una lista de "CREATE TABLE" en verde,
   sin errores en rojo.

---

## Paso 6 — Darle una URL pública a tu sitio

1. Click en el servicio de tu app → pestaña **"Settings"** → sección **"Networking"**.
2. Click en **"Generate Domain"**.
3. Railway te da una URL como `dinamikus-crm-production.up.railway.app` — esa es
   la dirección de tu sitio, ya con HTTPS (candado seguro), lista para usar.

---

## Paso 7 — Probarlo

1. Abre la URL que te dio Railway.
2. Deberías ver la pantalla de login. Click en "Crear cuenta" y registra un negocio
   de prueba.
3. Ya puedes navegar el Dashboard, el Inbox, y Canales con datos reales guardándose
   en tu base de datos de Railway.

---

## Cuando yo te entregue una actualización

Cada vez que te comparta una nueva versión del código:
1. Borra el contenido del repositorio en GitHub (o crea uno nuevo) y sube los
   archivos actualizados de la misma forma que en el Paso 1.
   *(Más adelante, si quieres, te puedo ayudar a dejarlo tan simple como "arrastrar
   y soltar" con GitHub Desktop, sin borrar nada — pero para empezar esto funciona.)*
2. Railway detecta el cambio y redeploya automáticamente — no hay que tocar nada
   más en Railway.

---

## Si algo falla
- **La app no arranca / "Application failed to respond"**: revisa la pestaña "Deployments"
  del servicio de tu app → click en el deploy más reciente → "View Logs". Ahí sale el
  error exacto en texto — cópialo y compártemelo, lo resolvemos juntos.
- **Error de conexión a la base de datos**: confirma que `PGSSL` esté en `true` y que
  la variable `DATABASE_URL` esté conectada por referencia al servicio Postgres (Paso 3).
