// Project identities are public. Badge labels and write policy derive from these
// URLs and the browser origin, never Git metadata or a client-supplied mode.
export const PROJECTS = {
  dev: 'https://qhndiuahuxczujxxitsm.supabase.co',
  prod: 'https://hpszwgnwxtxyxpcaivgj.supabase.co',
} as const;
// LOCAL Docker API, kept below Windows' dynamic/excluded port range.
export const LOCAL_API_URL = 'http://127.0.0.1:48321';
export type Target = 'local' | 'dev' | 'prod';
export type Environment = {target: Target; badge: 'LOCAL' | 'DEV' | 'PROD' | null; readOnly: boolean; storageKey: string};
export const READ_ONLY_MESSAGE = 'Production inspection: application writes are disabled. This is an application safeguard, not database-enforced read-only access.';

function parse(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Invalid connection configuration.');
  return url;
}
export function isLoopback(host: string) {return ['localhost', '127.0.0.1', '[::1]'].includes(host);}
export function validateDevOrigin(value: string) {
  const url = parse(value);
  if (url.protocol !== 'https:' || url.port || !/^[a-z0-9-]+\.(ngrok-free\.app|ngrok-free\.dev|ngrok\.app|ngrok\.dev)$/.test(url.hostname)) throw Error('Use your exact HTTPS ngrok development origin.');
  return url.origin;
}
// Never enable the tunnel exception on a hosted deployment or production build.
export function configuredDevOrigin(env: Record<string, string | undefined>) {
  return env.NODE_ENV === 'development' && !env.VERCEL_ENV && !env.VERCEL_URL && env.DUTY_SUPABASE_TARGET === 'dev' && env.SUPABASE_URL === PROJECTS.dev && env.DUTY_DEV_ORIGIN
    ? validateDevOrigin(env.DUTY_DEV_ORIGIN) : undefined;
}
// LOCAL phone testing: Next proxies only Auth/REST paths of the loopback LOCAL
// API through the same tunnel. Uses its own variable, so the DEV tunnel setting
// cannot enable it; never on hosted deployments, builds, DEV or PROD.
export const LOCAL_PROXY_PATHS = ['/auth/v1', '/rest/v1'] as const;
export function configuredLocalTunnel(env: Record<string, string | undefined>) {
  try {
    if (env.NODE_ENV !== 'development' || env.VERCEL || env.VERCEL_ENV || env.VERCEL_URL || env.DUTY_SUPABASE_TARGET !== 'local'
      || env.DUTY_DEV_ORIGIN || env.DUTY_PRODUCTION_INSPECTION || !env.SUPABASE_URL || !env.DUTY_LOCAL_TUNNEL_ORIGIN) return undefined;
    const api = new URL(env.SUPABASE_URL);
    if (connectionTarget(env.SUPABASE_URL) !== 'local' || api.hostname !== '127.0.0.1') return undefined;
    return {origin: validateDevOrigin(env.DUTY_LOCAL_TUNNEL_ORIGIN), api: api.origin};
  } catch {return undefined;}
}
export function connectionTarget(value: string): Target {
  const url = parse(value);
  if (url.origin === PROJECTS.dev) return 'dev';
  if (url.origin === PROJECTS.prod) return 'prod';
  if (url.protocol === 'http:' && isLoopback(url.hostname) && url.port) return 'local';
  throw Error('Unknown Supabase project.');
}
export function validatePublicKey(url: string, key: string) {
  const target = connectionTarget(url);
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return;
  // Local CLI versions also issue legacy anon JWTs. Decode only to reject
  // privileged keys; signature/authorization remain Supabase's responsibility.
  if (target === 'local' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) {
    try {
      const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.role === 'anon' && payload.iss === 'supabase-demo') return;
    } catch {}
  }
  throw Error('Only a public Supabase key is supported.');
}
export function resolveEnvironment(value: string, origin: string, deploymentOrigin?: string, devOrigin?: string, localTunnel?: string): Environment {
  const url = parse(value), runtime = parse(origin), target = connectionTarget(value);
  const local = isLoopback(runtime.hostname) && ['http:', 'https:'].includes(runtime.protocol);
  const devHost = runtime.origin === 'https://duty-scheduler-dev.vercel.app';
  const prodHost = runtime.origin === 'https://duty-scheduler-prod.vercel.app';
  const deployment = deploymentOrigin === runtime.origin && runtime.protocol === 'https:' && runtime.hostname.endsWith('.vercel.app');
  const tunnel = target === 'dev' && devOrigin !== undefined && runtime.origin === validateDevOrigin(devOrigin);
  const localTunnelMatch = target === 'local' && localTunnel !== undefined && runtime.origin === validateDevOrigin(localTunnel);
  // The documented browser container reaches the local Next server here.
  if ((devHost && target !== 'dev') || (prodHost && target !== 'prod')) throw Error('Runtime origin and Supabase project do not match.');
  const browserContainer = runtime.hostname === 'host.docker.internal' && runtime.protocol === 'http:' && target === 'dev';
  if (!local && !browserContainer && !tunnel && !localTunnelMatch && !(target === 'dev' && (devHost || deployment)) && !(target === 'prod' && (prodHost || deployment))) throw Error('Runtime origin and Supabase project do not match.');
  const readOnly = local && target === 'prod';
  return {target, badge: target === 'local' ? 'LOCAL' : target === 'dev' ? 'DEV' : readOnly ? 'PROD' : null,
    readOnly, storageKey: `duty-${url.host.replace(/[^\w-]/g, '-')}-auth`};
}
