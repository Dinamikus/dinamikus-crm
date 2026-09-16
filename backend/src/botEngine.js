import { pool } from './db.js';
import { procesarMensajeBotCitas, procesarRecordatoriosCitas } from './botCitasEngine.js';

// Enrutador: cada tipo de negocio tiene su propio módulo de motor (su propio
// prompt, sus propios pasos, sus propias tablas), pero todos entran por aquí.
// Para agregar un bot nuevo (ej. "ventas"): escribir botVentasEngine.js con la
// misma forma (procesarMensajeBotVentas, y su propio cron si aplica) y agregar
// su caso a MOTORES abajo — no se toca nada de lo que ya funciona.
const MOTORES = {
  citas: { procesarMensaje: procesarMensajeBotCitas, procesarRecordatorios: procesarRecordatoriosCitas }
  // ventas: { procesarMensaje: procesarMensajeBotVentas, procesarRecordatorios: null }
};

export async function procesarMensajeBot({ tenantId, conversationId, leadId, mensajeTexto }) {
  const config = await pool.query('SELECT tipo_bot, activo FROM bot_config WHERE tenant_id = $1', [tenantId]);
  const row = config.rows[0];
  if (!row || !row.activo) return;

  const motor = MOTORES[row.tipo_bot];
  if (!motor) {
    console.error(`[bot] tipo_bot desconocido para tenant ${tenantId}: ${row.tipo_bot}`);
    return;
  }

  return motor.procesarMensaje({ tenantId, conversationId, leadId, mensajeTexto });
}

// Cron de seguimiento — se llama cada 15 min desde server.js. Corre el cron de
// CADA tipo de bot que tenga al menos un negocio activo con ese tipo; cada
// consulta interna ya filtra por tenant según bot_config, así que es seguro
// correrlos todos aunque un tipo en particular no tenga negocios activos.
export async function procesarRecordatorios() {
  const tiposActivos = await pool.query(
    'SELECT DISTINCT tipo_bot FROM bot_config WHERE activo = true'
  );
  for (const { tipo_bot: tipoBot } of tiposActivos.rows) {
    const motor = MOTORES[tipoBot];
    if (!motor || !motor.procesarRecordatorios) continue;
    try {
      await motor.procesarRecordatorios();
    } catch (error) {
      console.error(`[bot] Error en cron de recordatorios (tipo_bot=${tipoBot}):`, error.message);
    }
  }
}
