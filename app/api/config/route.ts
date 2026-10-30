import {configuredDevOrigin,configuredLocalTunnel,isLoopback,resolveEnvironment, validatePublicKey} from '../../../lib/supabase/environment.ts';
export const dynamic = 'force-dynamic';

export async function GET(request: Request){
 const url=process.env.SUPABASE_URL;
 const key=process.env.SUPABASE_PUBLISHABLE_KEY;
 const headers={'Cache-Control':'no-store'};
 const deploymentOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined;
 let devOrigin: string | undefined, localTunnel: string | undefined;
 try {
  if (!url || !key) throw Error('Not configured');
  validatePublicKey(url, key);
  devOrigin = configuredDevOrigin(process.env);
  localTunnel = configuredLocalTunnel(process.env)?.origin;
  const tunnelOrigin = devOrigin ?? localTunnel;
  const runtime = new URL(request.url);
  let origin = runtime.origin;
  // Next builds request.url from its loopback bind address. Trust only the
  // explicitly configured tunnel host/protocol, never arbitrary proxy headers.
  if (tunnelOrigin) {
   const host = request.headers.get('host');
   const forwardedHost = request.headers.get('x-forwarded-host');
   const protocol = request.headers.get('x-forwarded-proto');
   if (host === new URL(tunnelOrigin).host) {
    if ((forwardedHost && forwardedHost !== host) || protocol !== 'https') throw Error('Origin mismatch');
    origin = tunnelOrigin;
   } else if (host && host !== runtime.host && !(isLoopback(runtime.hostname) && ['localhost','127.0.0.1','[::1]'].some(name=>host===`${name}:${runtime.port}`))) throw Error('Origin mismatch');
  }
  const environment = resolveEnvironment(url, origin, deploymentOrigin, devOrigin, localTunnel);
  if (process.env.DUTY_SUPABASE_TARGET && process.env.DUTY_SUPABASE_TARGET !== environment.target) throw Error('Target mismatch');
  if (process.env.VERCEL_ENV && (environment.target === 'local' || environment.target !== (process.env.VERCEL_ENV === 'production' ? 'prod' : 'dev'))) throw Error('Hosting mismatch');
  if (environment.readOnly && process.env.DUTY_PRODUCTION_INSPECTION !== 'confirmed') throw Error('Confirmation required');
 } catch {return Response.json({error:'Not configured'},{status:503,headers});}
 // Only the public, RLS-protected client configuration crosses into the browser.
 return Response.json({url,key,...(deploymentOrigin ? {deploymentOrigin} : {}),...(devOrigin ? {devOrigin} : {}),...(localTunnel ? {localTunnel} : {})},{headers});
}
