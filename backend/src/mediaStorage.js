import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const bucket = process.env.MEDIA_BUCKET;

const s3 = new S3Client({
  region: process.env.MEDIA_REGION || 'auto',
  endpoint: process.env.MEDIA_ENDPOINT,
  credentials: {
    accessKeyId: process.env.MEDIA_ACCESS_KEY_ID,
    secretAccessKey: process.env.MEDIA_SECRET_ACCESS_KEY
  }
});

export function mediaConfigured() {
  return Boolean(process.env.MEDIA_BUCKET && process.env.MEDIA_ENDPOINT && process.env.MEDIA_ACCESS_KEY_ID);
}

const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf'
};

export function extensionForMime(mimeType, fallbackFileName) {
  if (mimeType && MIME_EXTENSIONS[mimeType]) return MIME_EXTENSIONS[mimeType];
  if (fallbackFileName && fallbackFileName.includes('.')) return fallbackFileName.split('.').pop();
  if (mimeType && mimeType.includes('/')) return mimeType.split('/')[1];
  return 'bin';
}

// Sube un archivo (imagen, audio, etc.) al bucket. La key incluye el tenant y el
// canal para mantener todo organizado y evitar cualquier choque de nombres entre
// negocios distintos.
export async function uploadMedia({ tenantId, channelId, messageExternalId, buffer, mimeType, extension }) {
  const safeExt = extension || 'bin';
  const key = `${tenantId}/${channelId}/${messageExternalId || Date.now()}.${safeExt}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType || 'application/octet-stream'
    })
  );

  return key;
}

// Genera un enlace temporal (10 minutos) para ver/descargar un archivo — nunca
// exponemos el bucket directamente, siempre pasa por esta función bajo demanda.
export async function getMediaUrl(key) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(s3, command, { expiresIn: 600 });
}
