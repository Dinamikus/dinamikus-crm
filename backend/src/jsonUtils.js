// JSON.stringify normal truena con BigInt y con referencias circulares —
// ambas cosas pasan con los objetos de mensaje que devuelve Baileys (WhatsApp QR).
export function safeJsonStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
  } catch {
    return JSON.stringify({ note: 'raw payload no serializable' });
  }
}
