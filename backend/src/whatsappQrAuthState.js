import { proto, initAuthCreds, BufferJSON } from 'baileys';
import { pool } from './db.js';

// Misma idea que el useMultiFileAuthState oficial de Baileys, pero en vez de un
// archivo por clave, todo el estado (credenciales + claves de la sesión de señal)
// vive en una sola fila JSONB en Postgres — así sobrevive un redeploy de Railway
// sin que el asesor tenga que volver a escanear el QR.
export async function usePostgresAuthState(channelId) {
  const existing = await pool.query(
    'SELECT auth_state FROM whatsapp_qr_sessions WHERE channel_id = $1',
    [channelId]
  );

  // auth_state guarda { creds, keys: { "tipo-id": valor } } — serializado con
  // BufferJSON porque las credenciales de Baileys contienen Buffers binarios que
  // JSON.stringify normal no sabe representar.
  let store;
  if (existing.rowCount > 0) {
    store = JSON.parse(JSON.stringify(existing.rows[0].auth_state), BufferJSON.reviver);
  } else {
    store = { creds: initAuthCreds(), keys: {} };
    await pool.query(
      `INSERT INTO whatsapp_qr_sessions (channel_id, auth_state) VALUES ($1, $2)
       ON CONFLICT (channel_id) DO NOTHING`,
      [channelId, JSON.parse(JSON.stringify(store, BufferJSON.replacer))]
    );
  }

  const persist = async () => {
    await pool.query(
      `INSERT INTO whatsapp_qr_sessions (channel_id, auth_state, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (channel_id) DO UPDATE SET auth_state = $2, updated_at = NOW()`,
      [channelId, JSON.parse(JSON.stringify(store, BufferJSON.replacer))]
    );
  };

  return {
    state: {
      creds: store.creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = store.keys[`${type}-${id}`];
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value !== undefined) data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) store.keys[key] = value;
              else delete store.keys[key];
            }
          }
          await persist();
        }
      }
    },
    saveCreds: async () => {
      store.creds = store.creds; // ya está referenciado; solo persistimos
      await persist();
    }
  };
}

// Borra la sesión guardada (al desconectar un canal QR de verdad, no solo pausarlo).
export async function deletePostgresAuthState(channelId) {
  await pool.query('DELETE FROM whatsapp_qr_sessions WHERE channel_id = $1', [channelId]);
}
