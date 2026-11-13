export type KeyKind = 'publishable' | 'secret';

const PREFIX: Record<KeyKind, string> = { publishable: 'lk_pub_', secret: 'lk_sec_' };

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A new random key: prefix + 32 hex characters (128 bits). */
export function generateKey(kind: KeyKind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return PREFIX[kind] + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function keyKindOf(key: string): KeyKind | null {
  if (key.startsWith(PREFIX.publishable)) return 'publishable';
  if (key.startsWith(PREFIX.secret)) return 'secret';
  return null;
}

/** Bearer token from an Authorization header, or null. */
export function bearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

/** Constant-time comparison of two hex strings of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
