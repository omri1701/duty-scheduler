// Project identities are public. Badge labels and write policy derive from these
// URLs and the browser origin, never Git metadata or a client-supplied mode.
export const PROJECTS = {
  dev: 'https://qhndiuahuxczujxxitsm.supabase.co',
  prod: 'https://hpszwgnwxtxyxpcaivgj.supabase.co',
} as const;
export type Target = 'local' | 'dev' | 'prod';
export type Environment = {target: Target; badge: 'LOCAL' | 'DEV' | 'PROD' | null; readOnly: boolean; storageKey: string};
export const READ_ONLY_MESSAGE = 'Production inspection: application writes are disabled. This is an application safeguard, not database-enforced read-only access.';

function parse(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Invalid connection configuration.');
  return url;
}
export function isLoopback(host: string) {return ['localhost', '127.0.0.1', '[::1]'].includes(host);}
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
export function resolveEnvironment(value: string, origin: string, deploymentOrigin?: string): Environment {
  const url = parse(value), runtime = parse(origin), target = connectionTarget(value);
  const local = isLoopback(runtime.hostname) && ['http:', 'https:'].includes(runtime.protocol);
  const devHost = runtime.origin === 'https://duty-scheduler-dev.vercel.app';
  const prodHost = runtime.origin === 'https://duty-scheduler-prod.vercel.app';
  const deployment = deploymentOrigin === runtime.origin && runtime.protocol === 'https:' && runtime.hostname.endsWith('.vercel.app');
  // The documented browser container reaches the local Next server here.
  if ((devHost && target !== 'dev') || (prodHost && target !== 'prod')) throw Error('Runtime origin and Supabase project do not match.');
  const browserContainer = runtime.hostname === 'host.docker.internal' && runtime.protocol === 'http:' && target === 'dev';
  if (!local && !browserContainer && !(target === 'dev' && (devHost || deployment)) && !(target === 'prod' && (prodHost || deployment))) throw Error('Runtime origin and Supabase project do not match.');
  const readOnly = local && target === 'prod';
  return {target, badge: target === 'local' ? 'LOCAL' : target === 'dev' ? 'DEV' : readOnly ? 'PROD' : null,
    readOnly, storageKey: `duty-${url.host.replace(/[^\w-]/g, '-')}-auth`};
}
