import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import 'dotenv/config';
import { pool } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '7d';

export async function hashPassword(plain) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.verify(token, JWT_SECRET);
}

// Express middleware: requires a valid Bearer token, attaches req.user = { id, tenantId, role, isPlatformAdmin }.
// También confirma en la base que el usuario siga activo Y que su negocio no esté
// pausado — así, si se desactiva a alguien o se pausa todo un negocio, el acceso
// se corta de inmediato en la siguiente petición, no hasta que expire el token.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  try {
    const decoded = verifyToken(token);

    const result = await pool.query(
      `SELECT u.is_active, u.is_platform_admin, t.is_active AS tenant_is_active
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [decoded.sub]
    );
    if (result.rowCount === 0 || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'Esta cuenta fue desactivada' });
    }
    if (!result.rows[0].tenant_is_active) {
      return res.status(403).json({ error: 'Este negocio fue pausado. Contacta a tu proveedor.' });
    }

    req.user = {
      id: decoded.sub,
      tenantId: decoded.tenantId,
      role: decoded.role,
      isPlatformAdmin: result.rows[0].is_platform_admin
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Gate para endpoints exclusivos del dueño de la plataforma (ve todos los negocios,
// no solo el suyo). No es un "role" de tenant — es un permiso aparte, orthogonal.
export function requirePlatformAdmin(req, res, next) {
  if (!req.user || !req.user.isPlatformAdmin) {
    return res.status(403).json({ error: 'Solo el dueño de la plataforma puede hacer esto' });
  }
  next();
}

// Optional role gate: use after requireAuth, e.g. requireRole('admin')
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
