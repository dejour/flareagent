const encoder = new TextEncoder();
async function key(secret: string) {
  if (!/^[0-9a-f]{64}$/.test(secret))
    throw new Error('CREDENTIAL_KEY must be 32 random bytes encoded as hex');
  return crypto.subtle.importKey(
    'raw',
    Uint8Array.from(secret.match(/../g)!, (h) => parseInt(h, 16)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function seal(secret: string, scope: string, bytes: ArrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(scope) },
    await key(secret),
    bytes,
  );
  const result = new Uint8Array(12 + encrypted.byteLength);
  result.set(iv);
  result.set(new Uint8Array(encrypted), 12);
  return result;
}
export async function unseal(
  secret: string,
  scope: string,
  bytes: ArrayBuffer,
) {
  return crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes.slice(0, 12),
      additionalData: encoder.encode(scope),
    },
    await key(secret),
    bytes.slice(12),
  );
}
