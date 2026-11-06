// Browser push services a device may register (mirrors duty_private.save_push_subscription).
// The sender contacts nothing else, so a stored endpoint can never aim it at another host.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)$/;
export const BASE64URL_KEY = {p256dh: /^[A-Za-z0-9_-]{80,100}$/, auth: /^[A-Za-z0-9_-]{16,44}$/};

export function supportedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length < 20 || endpoint.length > 1000) return false;
  let url: URL;
  try {url = new URL(endpoint);} catch {return false;}
  return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443') && PUSH_HOSTS.test(url.hostname)
    && /^https:\/\/[^/?#@]+\//.test(endpoint);
}

/** Bytes to unpadded base64url, the encoding the database stores. */
export function base64url(bytes: ArrayBuffer | null): string {
  if (!bytes) return '';
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The VAPID public key (base64url) as the bytes PushManager.subscribe expects. */
export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4);
  const binary = atob(padded), bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export const validVapidPublicKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9_-]{86,88}$/.test(key);
