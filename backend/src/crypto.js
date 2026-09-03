import crypto from 'crypto';
import 'dotenv/config';

// ENCRYPTION_KEY debe ser una cadena hex de 64 caracteres (32 bytes) — genera una con:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const KEY_HEX = process.env.ENCRYPTION_KEY;

function getKey() {
  if (!KEY_HEX || KEY_HEX.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY debe estar configurada en .env como una cadena hex de 64 caracteres (32 bytes)'
    );
  }
  return Buffer.from(KEY_HEX, 'hex');
}

// Devuelve "iv:authTag:ciphertext" en hex — todo lo necesario para descifrar más adelante.
export function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12); // recomendado para GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(payload) {
  const [ivHex, authTagHex, dataHex] = payload.split(':');
  if (!ivHex || !authTagHex || !dataHex) throw new Error('Formato de dato cifrado inválido');

  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}
