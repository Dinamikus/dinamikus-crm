import { pool } from './db.js';
import { sendOutboundToLead } from './outboundMessage.js';
import { plantillas } from './botTemplates.js';

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

// Punto de entrada: se llama desde inboundMessage.js por cada mensaje entrante
// de un canal SIN dueño individual (un canal de WhatsApp QR "del negocio", no
// el celular personal de un asesor — mismo criterio que ya usa el mensaje de
// bienvenida). No hace nada si el negocio no tiene el bot activado.
export async function procesarMensajeBotCitas({ tenantId, conversationId, leadId, mensajeTexto }) {
  console.log(`[bot-citas] función invocada, mensajeTexto=${JSON.stringify(mensajeTexto)}`);
  if (!mensajeTexto) return;

  const config = await getBotConfig(tenantId);
  console.log(`[bot-citas] getBotConfig resultado: ${JSON.stringify(config)}`);
  if (!config || !config.activo) {
    console.log('[bot-citas] saliendo temprano: config ausente o inactiva');
    return;
  }
  console.log(`[bot-citas] procesando mensaje "${mensajeTexto}" para conversation=${conversationId}`);

  let estado = await getOrCreateConversationState({ conversationId, tenantId, leadId });
  console.log(`[bot-citas] estado obtenido, paso_actual=${estado.paso_actual}, bot_pausado=${estado.bot_pausado}`);

  if (estado.bot_pausado) {
    if (estado.pausado_hasta && new Date() > new Date(estado.pausado_hasta)) {
      estado = await actualizarEstado(conversationId, { bot_pausado: false, pausado_hasta: null });
    } else {
      return; // un asesor tiene el control de esta conversación, el bot no interviene
    }
  }

  const contexto = await construirContextoNegocio(tenantId, config, estado);

  let interp;
  try {
    console.log('[bot-citas] llamando a Claude...');
    interp = await llamarClaude(contexto, mensajeTexto);
    console.log('[bot-citas] Claude respondió:', JSON.stringify(interp));
  } catch (error) {
    console.error('[bot] Error llamando a la API de Claude:', error.message);
    // Aunque la interpretación falle, es mejor un mensaje genérico que dejar
    // al paciente sin ninguna respuesta — así detectamos el problema (queda
    // en los logs) sin que la conversación se sienta "muerta" del otro lado.
    return enviarMensaje(tenantId, leadId, plantillas.noEntendido());
  }

  await manejarIntencion(interp, estado, config, tenantId, leadId, conversationId);
}

async function getBotConfig(tenantId) {
  const result = await pool.query('SELECT * FROM bot_config WHERE tenant_id = $1', [tenantId]);
  return result.rows[0] || null;
}

async function getOrCreateConversationState({ conversationId, tenantId, leadId }) {
  const existing = await pool.query(
    'SELECT * FROM bot_conversation_state WHERE conversation_id = $1',
    [conversationId]
  );
  if (existing.rowCount > 0) return existing.rows[0];

  const created = await pool.query(
    `INSERT INTO bot_conversation_state (conversation_id, tenant_id, lead_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [conversationId, tenantId, leadId]
  );
  return created.rows[0];
}

async function actualizarEstado(conversationId, cambios) {
  const campos = Object.keys(cambios);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const valores = campos.map((c) => cambios[c]);
  const result = await pool.query(
    `UPDATE bot_conversation_state SET ${sets}, updated_at = NOW() WHERE conversation_id = $1 RETURNING *`,
    [conversationId, ...valores]
  );
  return result.rows[0];
}

async function construirContextoNegocio(tenantId, config, estado) {
  const [servicios, faqs, ubicaciones, historial] = await Promise.all([
    pool.query(
      'SELECT id, nombre, duracion_minutos, permite_presencial, permite_virtual FROM bot_services WHERE tenant_id = $1 AND activo = true ORDER BY posicion',
      [tenantId]
    ),
    pool.query('SELECT pregunta, respuesta FROM bot_faqs WHERE tenant_id = $1 AND activo = true', [tenantId]),
    pool.query(
      'SELECT id, nombre, direccion, nota FROM bot_locations WHERE tenant_id = $1 AND activo = true ORDER BY posicion',
      [tenantId]
    ),
    pool.query(
      'SELECT direction, body FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 3',
      [estado.conversation_id]
    )
  ]);

  return {
    nombreNegocio: config.nombre_negocio || 'nuestra clínica',
    servicios: servicios.rows,
    faqs: faqs.rows,
    ubicaciones: ubicaciones.rows,
    horario: config.horario_atencion,
    timezone: config.timezone,
    pasoActual: estado.paso_actual,
    datosRecolectados: estado.datos_recolectados,
    historial: historial.rows.reverse(),
    fechaActualIso: new Date().toISOString()
  };
}

function construirSystemPrompt(contexto) {
  return `Eres el motor de interpretación de un bot de WhatsApp para ${contexto.nombreNegocio}.
Tu única función es leer el mensaje del paciente y devolver un JSON con la intención y los
datos que lograste extraer. NUNCA respondes directamente al paciente, NUNCA inventas
información que no esté en el CONTEXTO DEL NEGOCIO.

CONTEXTO DEL NEGOCIO:
- Servicios disponibles (con si aceptan presencial/virtual): ${JSON.stringify(contexto.servicios)}
- Sedes/ubicaciones (si hay más de una, el paciente debe elegir cuando la cita es presencial): ${JSON.stringify(contexto.ubicaciones)}
- Horario de atención general (aplica a citas virtuales o si el negocio no tiene sedes): ${JSON.stringify(contexto.horario)}
- FAQs configuradas: ${JSON.stringify(contexto.faqs)}

ESTADO ACTUAL DE LA CONVERSACIÓN:
- Paso actual: ${contexto.pasoActual}
- Datos ya recolectados: ${JSON.stringify(contexto.datosRecolectados)}
- Últimos mensajes: ${JSON.stringify(contexto.historial)}

Hoy es ${contexto.fechaActualIso} (zona horaria: ${contexto.timezone}).

Devuelve SOLO este JSON, sin texto adicional, sin backticks ni explicación:
{
  "intencion": "agendar | reagendar | cancelar | ver_citas | pregunta_faq | hablar_humano | no_entendido",
  "servicio_mencionado": string | null,
  "modalidad": "presencial" | "virtual" | null,
  "ubicacion_mencionada": string | null,
  "fecha_hora_normalizada": "YYYY-MM-DDTHH:mm" | null,
  "nombre_paciente": string | null,
  "confirma": true | false | null,
  "respuesta_faq": string | null,
  "confianza": "alta" | "media" | "baja"
}

Reglas:
- Normaliza fechas relativas ("mañana", "el viernes") usando la fecha de hoy indicada arriba.
- "modalidad" solo aplica cuando el paso actual pregunta por eso (o el paciente la menciona
  espontáneamente, ej. "quiero una cita virtual"); en cualquier otro caso va null.
- "ubicacion_mencionada" y "servicio_mencionado" solo aplican cuando el paso actual pregunta por
  eso; en cualquier otro caso van null. El bot muestra listas numeradas (1️⃣, 2️⃣...), así que si
  el paciente responde solo con el número ("2", "la 1"), pon ese mismo número tal cual en el
  campo — no lo descartes ni intentes adivinar el nombre. Ej.: si preguntó la sede y el paciente
  escribe "2", "ubicacion_mencionada" debe ser "2".
- "confirma" solo aplica cuando el paso actual es de confirmación; en cualquier otro caso va null.
- Si la intención es "pregunta_faq", solo puedes usar "respuesta_faq" si la respuesta está
  literalmente en las FAQs configuradas. Si no está, devuelve "hablar_humano" en vez de inventar.
- Si "confianza" es "baja" o faltan datos críticos para el paso actual, ese campo debe ir en null.
- Si el mensaje no tiene relación con nada de lo anterior, usa "no_entendido".`;
}

async function llamarClaude(contexto, mensajeTexto) {
  // Si la API tarda demasiado o la conexión se cuelga, es mejor que falle con
  // un error claro (y quede en los logs) a que la llamada se quede esperando
  // para siempre en silencio — fetch() no tiene timeout por defecto en Node.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: construirSystemPrompt(contexto),
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [{ role: 'user', content: mensajeTexto }]
      })
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('La API de Claude tardó más de 20s en responder (timeout)');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Anthropic API respondió ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const raw = (data.content && data.content[0] && data.content[0].text) || '{}';
  return JSON.parse(limpiarPosiblesBackticks(raw));
}

// Haiku a veces envuelve el JSON en un bloque de código markdown (```json ... ```)
// a pesar de que el prompt le pide no hacerlo. Se lo quitamos antes de parsear,
// en vez de confiar en que el modelo siempre obedezca al pie de la letra.
function limpiarPosiblesBackticks(texto) {
  const limpio = texto.trim();
  if (limpio.startsWith('```')) {
    return limpio
      .replace(/^```[a-zA-Z]*\s*/, '')
      .replace(/```\s*$/, '')
      .trim();
  }
  return limpio;
}

async function enviarMensaje(tenantId, leadId, texto) {
  console.log(`[bot-citas] enviando mensaje a lead=${leadId}: "${texto.slice(0, 60)}..."`);
  try {
    await sendOutboundToLead({ tenantId, leadId, body: texto });
    console.log('[bot-citas] mensaje enviado OK');
  } catch (error) {
    console.error('[bot] Error enviando mensaje:', error.message, error.stack);
  }
}

async function escalarAHumano(conversationId, tenantId, leadId) {
  await actualizarEstado(conversationId, { bot_pausado: true, pausado_hasta: null, intentos_no_entendido: 0 });
  await enviarMensaje(tenantId, leadId, plantillas.escalado());
}

async function manejarIntencion(interp, estado, config, tenantId, leadId, conversationId) {
  if (interp.intencion === 'hablar_humano') {
    return escalarAHumano(conversationId, tenantId, leadId);
  }

  // El reintento/escalado por "no entendí" solo aplica DENTRO de un flujo activo
  // (cuando el bot ya preguntó algo específico). En 'inicio' un saludo genérico
  // ("Hola", "buenas") es normal que la IA lo marque como no_entendido — ahí
  // simplemente se le muestra el menú de bienvenida, no tiene sentido pedirle
  // que "reformule" un saludo.
  const enFlujoActivo = estado.paso_actual !== 'inicio';
  if (enFlujoActivo && (interp.intencion === 'no_entendido' || interp.confianza === 'baja')) {
    const intentos = (estado.intentos_no_entendido || 0) + 1;
    if (intentos >= config.max_reintentos_no_entendido) {
      return escalarAHumano(conversationId, tenantId, leadId);
    }
    await actualizarEstado(conversationId, { intentos_no_entendido: intentos });
    return enviarMensaje(tenantId, leadId, plantillas.noEntendido());
  }

  if (estado.intentos_no_entendido > 0) {
    await actualizarEstado(conversationId, { intentos_no_entendido: 0 });
  }

  switch (estado.paso_actual) {
    case 'esperando_servicio':
      return manejarServicio(interp, estado, tenantId, leadId, conversationId);
    case 'esperando_modalidad':
      return manejarModalidad(interp, estado, tenantId, leadId, conversationId);
    case 'esperando_ubicacion':
      return manejarUbicacion(interp, estado, tenantId, leadId, conversationId);
    case 'esperando_fecha_hora':
      return manejarFechaHora(interp, estado, config, tenantId, leadId, conversationId);
    case 'esperando_nombre':
      return manejarNombre(interp, estado, config, tenantId, leadId, conversationId);
    case 'esperando_confirmacion':
      return manejarConfirmacion(interp, estado, config, tenantId, leadId, conversationId);
    case 'gestionando_cita_existente':
      return manejarGestionCitaExistente(interp, estado, tenantId, leadId, conversationId);
    default:
      return manejarInicio(interp, config, tenantId, leadId, conversationId);
  }
}

async function manejarInicio(interp, config, tenantId, leadId, conversationId) {
  switch (interp.intencion) {
    case 'agendar': {
      const servicios = await pool.query(
        'SELECT id, nombre, permite_presencial, permite_virtual FROM bot_services WHERE tenant_id = $1 AND activo = true ORDER BY posicion',
        [tenantId]
      );
      if (servicios.rowCount === 1) {
        return avanzarDespuesDeServicio(servicios.rows[0], {}, tenantId, leadId, conversationId);
      }
      await actualizarEstado(conversationId, { paso_actual: 'esperando_servicio' });
      return enviarMensaje(tenantId, leadId, plantillas.pedirServicio(servicios.rows));
    }
    case 'ver_citas':
      return mostrarCitaActiva(tenantId, leadId, conversationId, config);
    case 'pregunta_faq':
      return enviarMensaje(tenantId, leadId, interp.respuesta_faq || plantillas.escalado());
    default:
      return enviarMensaje(tenantId, leadId, plantillas.bienvenida(config.nombre_negocio || 'nuestra clínica'));
  }
}

// El bot muestra listas numeradas (1️⃣, 2️⃣...) y es normal que el paciente
// conteste solo con el número en vez de escribir el nombre completo. Esta
// función acepta ambos: si el texto es un número dentro del rango de la
// lista, selecciona por posición; si no, busca coincidencia por nombre.
function resolverPorNumeroOTexto(items, textoCrudo) {
  const limpio = (textoCrudo || '').trim();
  if (!limpio) return null;

  const numero = Number(limpio);
  if (Number.isInteger(numero) && String(numero) === limpio && numero >= 1 && numero <= items.length) {
    return items[numero - 1];
  }

  const textoLower = limpio.toLowerCase();
  return items.find((it) => it.nombre.toLowerCase().includes(textoLower)) || null;
}

async function manejarServicio(interp, estado, tenantId, leadId, conversationId) {
  const servicios = await pool.query(
    'SELECT id, nombre, permite_presencial, permite_virtual FROM bot_services WHERE tenant_id = $1 AND activo = true ORDER BY posicion',
    [tenantId]
  );
  const match = resolverPorNumeroOTexto(servicios.rows, interp.servicio_mencionado);

  if (!match) {
    return enviarMensaje(tenantId, leadId, plantillas.pedirServicio(servicios.rows));
  }

  return avanzarDespuesDeServicio(match, estado.datos_recolectados, tenantId, leadId, conversationId);
}

// Un servicio puede aceptar presencial, virtual, o ambos. Si acepta ambos, se
// pregunta; si solo acepta uno, se salta esa pregunta directo a resolver sede
// (si aplica) o fecha/hora.
async function avanzarDespuesDeServicio(servicio, datosPrevios, tenantId, leadId, conversationId) {
  const datos = { ...datosPrevios, service_id: servicio.id, servicioNombre: servicio.nombre };

  if (servicio.permite_presencial && servicio.permite_virtual) {
    await actualizarEstado(conversationId, { paso_actual: 'esperando_modalidad', datos_recolectados: datos });
    return enviarMensaje(tenantId, leadId, plantillas.preguntarModalidad());
  }

  const modalidad = servicio.permite_virtual ? 'virtual' : 'presencial';
  return avanzarDespuesDeModalidad(modalidad, datos, tenantId, leadId, conversationId);
}

async function manejarModalidad(interp, estado, tenantId, leadId, conversationId) {
  if (interp.modalidad !== 'presencial' && interp.modalidad !== 'virtual') {
    return enviarMensaje(tenantId, leadId, plantillas.preguntarModalidad());
  }
  return avanzarDespuesDeModalidad(interp.modalidad, estado.datos_recolectados, tenantId, leadId, conversationId);
}

// Si es presencial y el negocio tiene más de una sede activa, pregunta cuál.
// Si tiene exactamente una, la asigna sola. Si no tiene ninguna configurada
// (negocio de una sola ubicación que no usó esta función), sigue como antes:
// sin location_id, usando el horario general de bot_config.
async function avanzarDespuesDeModalidad(modalidad, datosPrevios, tenantId, leadId, conversationId) {
  let datos = { ...datosPrevios, modalidad };

  if (modalidad === 'presencial') {
    const ubicaciones = await pool.query(
      'SELECT id, nombre, direccion, nota FROM bot_locations WHERE tenant_id = $1 AND activo = true ORDER BY posicion',
      [tenantId]
    );
    if (ubicaciones.rowCount > 1) {
      await actualizarEstado(conversationId, { paso_actual: 'esperando_ubicacion', datos_recolectados: datos });
      return enviarMensaje(tenantId, leadId, plantillas.pedirUbicacion(ubicaciones.rows));
    }
    if (ubicaciones.rowCount === 1) {
      const sede = ubicaciones.rows[0];
      datos = { ...datos, location_id: sede.id, ubicacionNombre: sede.nombre, ubicacionDireccion: sede.direccion };
    }
  }

  await actualizarEstado(conversationId, { paso_actual: 'esperando_fecha_hora', datos_recolectados: datos });
  return enviarMensaje(tenantId, leadId, plantillas.pedirFechaHora());
}

async function manejarUbicacion(interp, estado, tenantId, leadId, conversationId) {
  const ubicaciones = await pool.query(
    'SELECT id, nombre, direccion, nota FROM bot_locations WHERE tenant_id = $1 AND activo = true ORDER BY posicion',
    [tenantId]
  );
  const match = resolverPorNumeroOTexto(ubicaciones.rows, interp.ubicacion_mencionada);

  if (!match) {
    return enviarMensaje(tenantId, leadId, plantillas.pedirUbicacion(ubicaciones.rows));
  }

  const datos = {
    ...estado.datos_recolectados,
    location_id: match.id,
    ubicacionNombre: match.nombre,
    ubicacionDireccion: match.direccion
  };
  await actualizarEstado(conversationId, { paso_actual: 'esperando_fecha_hora', datos_recolectados: datos });
  return enviarMensaje(tenantId, leadId, plantillas.pedirFechaHora());
}

async function manejarFechaHora(interp, estado, config, tenantId, leadId, conversationId) {
  if (!interp.fecha_hora_normalizada) {
    return enviarMensaje(tenantId, leadId, plantillas.pedirFechaHora());
  }

  const opciones = await buscarEspaciosDisponibles(
    tenantId,
    interp.fecha_hora_normalizada,
    estado.datos_recolectados.service_id,
    estado.datos_recolectados,
    config
  );

  if (opciones.length === 0) {
    return enviarMensaje(tenantId, leadId, plantillas.sinDisponibilidad());
  }

  // MVP: se toma la primera opción sugerida como la elegida y se pide el
  // nombre para confirmar. Ofrecer selección entre las 2-3 opciones por
  // número es una mejora sencilla de agregar después en este mismo handler.
  await actualizarEstado(conversationId, {
    paso_actual: 'esperando_nombre',
    datos_recolectados: { ...estado.datos_recolectados, fecha_hora: opciones[0].toISOString() }
  });
  return enviarMensaje(tenantId, leadId, plantillas.mostrarOpciones(opciones, config.timezone));
}

async function manejarNombre(interp, estado, config, tenantId, leadId, conversationId) {
  const nombre = interp.nombre_paciente;
  if (!nombre) {
    return enviarMensaje(tenantId, leadId, plantillas.pedirNombre());
  }
  const datos = { ...estado.datos_recolectados, nombre };
  await actualizarEstado(conversationId, { paso_actual: 'esperando_confirmacion', datos_recolectados: datos });
  return enviarMensaje(tenantId, leadId, plantillas.resumenConfirmacion(datos, config.timezone));
}

async function manejarConfirmacion(interp, estado, config, tenantId, leadId, conversationId) {
  if (interp.confirma === false) {
    await actualizarEstado(conversationId, { paso_actual: 'inicio', datos_recolectados: {} });
    return enviarMensaje(tenantId, leadId, 'Sin problema, ¿en qué más te ayudo?');
  }
  if (interp.confirma !== true) {
    return enviarMensaje(tenantId, leadId, plantillas.resumenConfirmacion(estado.datos_recolectados, config.timezone));
  }

  const datos = estado.datos_recolectados;
  await pool.query(
    `INSERT INTO appointments (tenant_id, lead_id, service_id, fecha_hora, nombre_paciente, modalidad, location_id, estado, creado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmada', 'bot')`,
    [tenantId, leadId, datos.service_id, datos.fecha_hora, datos.nombre, datos.modalidad, datos.location_id || null]
  );

  if (config.appointment_stage_key) {
    await pool.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3', [
      config.appointment_stage_key,
      leadId,
      tenantId
    ]);
  }

  await actualizarEstado(conversationId, { paso_actual: 'inicio', datos_recolectados: {} });
  return enviarMensaje(tenantId, leadId, plantillas.citaConfirmada(datos, config.direccion, config.timezone));
}

async function mostrarCitaActiva(tenantId, leadId, conversationId, config) {
  const cita = await pool.query(
    `SELECT a.*, s.nombre AS servicio, l.nombre AS ubicacion_nombre FROM appointments a
     LEFT JOIN bot_services s ON s.id = a.service_id
     LEFT JOIN bot_locations l ON l.id = a.location_id
     WHERE a.tenant_id = $1 AND a.lead_id = $2 AND a.estado IN ('pendiente','confirmada')
     ORDER BY a.fecha_hora ASC LIMIT 1`,
    [tenantId, leadId]
  );
  if (cita.rowCount === 0) {
    return enviarMensaje(tenantId, leadId, plantillas.noTieneCitas());
  }
  await actualizarEstado(conversationId, {
    paso_actual: 'gestionando_cita_existente',
    datos_recolectados: { appointment_id: cita.rows[0].id }
  });
  return enviarMensaje(tenantId, leadId, plantillas.citaExistente(cita.rows[0], config.timezone));
}

async function manejarGestionCitaExistente(interp, estado, tenantId, leadId, conversationId) {
  const appointmentId = estado.datos_recolectados.appointment_id;

  if (interp.intencion === 'cancelar') {
    await pool.query("UPDATE appointments SET estado = 'cancelada', updated_at = NOW() WHERE id = $1", [
      appointmentId
    ]);
    await actualizarEstado(conversationId, { paso_actual: 'inicio', datos_recolectados: {} });
    return enviarMensaje(tenantId, leadId, plantillas.citaCancelada());
  }

  if (interp.intencion === 'reagendar') {
    await actualizarEstado(conversationId, { paso_actual: 'esperando_fecha_hora' });
    return enviarMensaje(tenantId, leadId, plantillas.pedirFechaHora());
  }

  await actualizarEstado(conversationId, { paso_actual: 'inicio', datos_recolectados: {} });
  return enviarMensaje(tenantId, leadId, '¿En qué más te ayudo?');
}

// Búsqueda de disponibilidad: busca huecos libres del tamaño de la duración del
// servicio, respetando el horario de atención y las citas ya ocupadas, empezando
// en la fecha pedida y avanzando hasta 7 días si no hay nada ese día.
//
// El horario que se respeta depende de la modalidad/sede ya resueltas en datos:
// - Si hay location_id (cita presencial con sede definida), usa el horario de
//   ESA sede y solo choca con otras citas de esa misma sede — sedes distintas
//   tienen calendarios independientes (el Dr. puede estar en ambas el mismo
//   día si el horario de cada una lo permite).
// - Si no hay location_id (virtual, o negocio sin sedes configuradas), usa el
//   horario general de bot_config y choca con las demás citas sin sede de esa
//   misma modalidad.
//
// Nota MVP: solo evita colisión con el inicio exacto de otra cita — para
// servicios de duración muy distinta conviene endurecer esto a detección de
// solapamiento real (rango contra rango) más adelante.
async function buscarEspaciosDisponibles(tenantId, fechaPreferidaIso, serviceId, datos, config) {
  const duracionResult = serviceId
    ? await pool.query('SELECT duracion_minutos FROM bot_services WHERE id = $1', [serviceId])
    : null;
  const duracion = (duracionResult && duracionResult.rows[0] && duracionResult.rows[0].duracion_minutos) || 30;

  let horarioFuente = config.horario_atencion;
  if (datos.location_id) {
    const sede = await pool.query('SELECT horario_atencion FROM bot_locations WHERE id = $1', [datos.location_id]);
    horarioFuente = (sede.rows[0] && sede.rows[0].horario_atencion) || {};
  }

  const fechaBase = new Date(fechaPreferidaIso);
  const opciones = [];

  for (let offset = 0; offset < 7 && opciones.length < 3; offset++) {
    const dia = new Date(fechaBase);
    dia.setDate(dia.getDate() + offset);
    const nombreDia = DIAS[dia.getDay()];
    const rango = horarioFuente && horarioFuente[nombreDia];
    if (!rango || rango.length !== 2) continue;

    const [horaInicio, minInicio] = rango[0].split(':').map(Number);
    const [horaFin, minFin] = rango[1].split(':').map(Number);

    const inicioDia = new Date(dia);
    inicioDia.setHours(horaInicio, minInicio, 0, 0);
    const finDia = new Date(dia);
    finDia.setHours(horaFin, minFin, 0, 0);

    const ocupadas = datos.location_id
      ? await pool.query(
          `SELECT fecha_hora FROM appointments
           WHERE location_id = $1 AND estado IN ('pendiente','confirmada')
           AND fecha_hora >= $2 AND fecha_hora < $3`,
          [datos.location_id, inicioDia, finDia]
        )
      : await pool.query(
          `SELECT fecha_hora FROM appointments
           WHERE tenant_id = $1 AND location_id IS NULL AND modalidad = $2
           AND estado IN ('pendiente','confirmada') AND fecha_hora >= $3 AND fecha_hora < $4`,
          [tenantId, datos.modalidad, inicioDia, finDia]
        );
    const ocupadasSet = new Set(ocupadas.rows.map((r) => new Date(r.fecha_hora).getTime()));

    let cursor = new Date(Math.max(inicioDia.getTime(), offset === 0 ? fechaBase.getTime() : inicioDia.getTime()));
    while (cursor < finDia && opciones.length < 3) {
      const finCita = new Date(cursor.getTime() + duracion * 60000);
      if (finCita <= finDia && !ocupadasSet.has(cursor.getTime())) {
        opciones.push(new Date(cursor));
      }
      cursor = new Date(cursor.getTime() + duracion * 60000);
    }
  }

  return opciones;
}

// Cron de seguimiento — se llama cada 15-30 min desde server.js (vía el enrutador en botEngine.js).
export async function procesarRecordatoriosCitas() {
  await enviarRecordatorios24h();
  await enviarRecordatorios2h();
  await procesarRecontactosNoShow();
}

async function enviarRecordatorios24h() {
  const citas = await pool.query(`
    SELECT a.id, a.tenant_id, a.lead_id, a.fecha_hora, s.nombre AS servicio, c.timezone
    FROM appointments a
    JOIN bot_config c ON c.tenant_id = a.tenant_id
    LEFT JOIN bot_services s ON s.id = a.service_id
    WHERE a.estado = 'confirmada' AND a.recordatorio_24h_enviado = false AND c.recordatorio_24h = true
    AND a.fecha_hora BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'
  `);
  for (const cita of citas.rows) {
    await enviarMensaje(cita.tenant_id, cita.lead_id, plantillas.recordatorio24h(cita, cita.timezone));
    await pool.query('UPDATE appointments SET recordatorio_24h_enviado = true WHERE id = $1', [cita.id]);
  }
}

async function enviarRecordatorios2h() {
  const citas = await pool.query(`
    SELECT a.id, a.tenant_id, a.lead_id, a.fecha_hora, s.nombre AS servicio, c.timezone
    FROM appointments a
    JOIN bot_config c ON c.tenant_id = a.tenant_id
    LEFT JOIN bot_services s ON s.id = a.service_id
    WHERE a.estado = 'confirmada' AND a.recordatorio_2h_enviado = false AND c.recordatorio_2h = true
    AND a.fecha_hora BETWEEN NOW() + INTERVAL '1 hour 45 minutes' AND NOW() + INTERVAL '2 hours 15 minutes'
  `);
  for (const cita of citas.rows) {
    await enviarMensaje(cita.tenant_id, cita.lead_id, plantillas.recordatorio2h(cita, cita.timezone));
    await pool.query('UPDATE appointments SET recordatorio_2h_enviado = true WHERE id = $1', [cita.id]);
  }
}

async function procesarRecontactosNoShow() {
  // Marca como no_show las citas confirmadas cuya hora ya pasó (30 min de margen).
  await pool.query(`
    UPDATE appointments SET estado = 'no_show', updated_at = NOW()
    WHERE estado = 'confirmada' AND fecha_hora < NOW() - INTERVAL '30 minutes'
  `);

  const citas = await pool.query(`
    SELECT a.id, a.tenant_id, a.lead_id
    FROM appointments a
    JOIN bot_config c ON c.tenant_id = a.tenant_id
    WHERE a.estado = 'no_show' AND a.recontacto_enviado = false AND c.recontacto_no_show = true
    AND a.fecha_hora <= NOW() - (c.dias_recontacto_no_show || ' days')::interval
  `);
  for (const cita of citas.rows) {
    await enviarMensaje(cita.tenant_id, cita.lead_id, plantillas.recontactoNoShow());
    await pool.query('UPDATE appointments SET recontacto_enviado = true WHERE id = $1', [cita.id]);
  }
}
