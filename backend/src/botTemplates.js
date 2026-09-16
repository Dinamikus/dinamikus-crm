export function formatearFechaHora(fecha, timezone) {
  return new Date(fecha).toLocaleString('es-SV', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone || 'America/El_Salvador'
  });
}

export const plantillas = {
  bienvenida: (nombreNegocio) =>
    `¡Hola! Soy el asistente virtual de ${nombreNegocio} 👋\n\n` +
    `¿En qué te puedo ayudar?\n` +
    `1️⃣ Agendar una cita\n` +
    `2️⃣ Ver mis citas\n` +
    `3️⃣ Preguntas frecuentes\n` +
    `4️⃣ Hablar con alguien`,

  pedirServicio: (servicios) =>
    `¿Qué servicio necesitas?\n` + servicios.map((s, i) => `${i + 1}️⃣ ${s.nombre}`).join('\n'),

  preguntarModalidad: () => `¿Prefieres la cita presencial o virtual?`,

  pedirUbicacion: (ubicaciones) =>
    `¿En cuál sede te queda mejor?\n\n` +
    ubicaciones
      .map((u, i) => `${i + 1}️⃣ ${u.nombre}${u.direccion ? ` — ${u.direccion}` : ''}${u.nota ? ` (${u.nota})` : ''}`)
      .join('\n'),

  pedirFechaHora: () =>
    `¿Qué día y hora te acomoda? Puedes escribirlo como prefieras, ` +
    `por ejemplo "el jueves en la tarde" o "mañana a las 3pm".`,

  mostrarOpciones: (opciones, timezone) =>
    `Estos son los espacios disponibles cerca de lo que pediste:\n\n` +
    opciones.map((o, i) => `${i + 1}️⃣ ${formatearFechaHora(o, timezone)}`).join('\n') +
    `\n\nEscríbeme a nombre de quién agendo y confirmamos la primera opción.`,

  sinDisponibilidad: () =>
    `No tengo espacios disponibles cerca de esa fecha. ¿Quieres que busque en otro día?`,

  pedirNombre: () => `Perfecto. ¿A nombre de quién agendo la cita?`,

  resumenConfirmacion: (datos, timezone) =>
    `Confirmemos tu cita:\n\n` +
    `📋 Servicio: ${datos.servicioNombre}\n` +
    `${datos.modalidad === 'virtual' ? '💻 Modalidad: Virtual' : `📍 Sede: ${datos.ubicacionNombre || 'presencial'}`}\n` +
    `📅 Fecha: ${formatearFechaHora(datos.fecha_hora, timezone)}\n` +
    `👤 Nombre: ${datos.nombre}\n\n` +
    `¿Confirmas? (responde "sí" o "no")`,

  citaConfirmada: (datos, direccionNegocio, timezone) =>
    `✅ ¡Listo! Tu cita quedó agendada:\n\n` +
    `${formatearFechaHora(datos.fecha_hora, timezone)} — ${datos.servicioNombre}\n` +
    (datos.modalidad === 'virtual'
      ? `💻 Es una cita virtual, te compartiremos el enlace antes de la hora.\n\n`
      : `📍 ${datos.ubicacionDireccion || direccionNegocio || ''}\n\n`) +
    `Te enviaremos un recordatorio antes de la cita.`,

  citaCancelada: () => `Tu cita fue cancelada. Si quieres agendar otra, aquí estoy.`,

  noTieneCitas: () => `No encuentro ninguna cita activa a tu nombre.`,

  citaExistente: (cita, timezone) =>
    `Tienes una cita activa:\n\n` +
    `${formatearFechaHora(cita.fecha_hora, timezone)} — ${cita.servicio}` +
    `${cita.modalidad === 'virtual' ? ' (virtual)' : cita.ubicacion_nombre ? ` (${cita.ubicacion_nombre})` : ''}\n\n` +
    `¿Qué quieres hacer? 1️⃣ Reagendar  2️⃣ Cancelar  3️⃣ Nada, gracias`,

  noEntendido: () => `Disculpa, no entendí bien 🙏 ¿Puedes reformularlo?`,

  escalado: () => `Ya te voy a comunicar con alguien de nuestro equipo, en un momento te atienden 🙌`,

  recordatorio24h: (cita, timezone) =>
    `📌 Recordatorio: tienes cita mañana ${formatearFechaHora(cita.fecha_hora, timezone)} — ${cita.servicio}. ` +
    `Responde "confirmo" o "cancelar".`,

  recordatorio2h: (cita, timezone) =>
    `⏰ Tu cita es en 2 horas (${formatearFechaHora(cita.fecha_hora, timezone)}). ¡Te esperamos!`,

  recontactoNoShow: () => `Notamos que no pudiste asistir a tu cita. ¿Todo bien? ¿Quieres reagendar?`
};
