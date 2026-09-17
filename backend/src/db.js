import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// Railway/Render suelen requerir SSL para Postgres administrado.
// PGSSL=true lo activa sin verificar el certificado (suficiente para estos proveedores).
const useSSL = process.env.PGSSL === 'true';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  // Antes no había ningún límite: si el pool se quedaba sin conexiones libres
  // (mucho tráfico simultáneo — varias sesiones de WhatsApp QR + el bot + uso
  // normal), una consulta podía quedarse esperando PARA SIEMPRE, sin error,
  // sin log, nada. Con esto, en vez de colgarse en silencio, falla con un
  // error claro que sí queda registrado.
  max: 15,
  connectionTimeoutMillis: 10000, // esperar como máximo 10s por una conexión libre del pool
  statement_timeout: 15000, // Postgres mata cualquier consulta que tarde más de 15s
  query_timeout: 15000 // el cliente también se rinde a los 15s si Postgres no contesta
});
