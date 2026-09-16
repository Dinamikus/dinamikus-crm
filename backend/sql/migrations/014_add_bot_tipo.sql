-- Permite que cada negocio tenga un tipo de bot distinto (citas, ventas, etc.).
-- Sin CHECK de valores permitidos a propósito: agregar un tipo nuevo (ej. 'ventas')
-- no debe requerir otra migración, solo un módulo de motor nuevo y su entrada
-- en el enrutador (backend/src/botEngine.js).
ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS tipo_bot TEXT NOT NULL DEFAULT 'citas';
