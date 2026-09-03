import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// Railway/Render suelen requerir SSL para Postgres administrado.
// PGSSL=true lo activa sin verificar el certificado (suficiente para estos proveedores).
const useSSL = process.env.PGSSL === 'true';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});
