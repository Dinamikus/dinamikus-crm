-- Ejecutar solo si ya corriste schema.sql antes de esta fecha.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','supervisor','agent'));
