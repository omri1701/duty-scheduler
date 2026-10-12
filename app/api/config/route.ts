import {resolveEnvironment, validatePublicKey} from '../../../lib/supabase/environment.ts';
export const dynamic = 'force-dynamic';

export async function GET(request: Request){
 const url=process.env.SUPABASE_URL;
 const key=process.env.SUPABASE_PUBLISHABLE_KEY;
 const headers={'Cache-Control':'no-store'};
 const deploymentOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined;
 try {
  if (!url || !key) throw Error('Not configured');
  validatePublicKey(url, key);
  const environment = resolveEnvironment(url, new URL(request.url).origin, deploymentOrigin);
  if (process.env.DUTY_SUPABASE_TARGET && process.env.DUTY_SUPABASE_TARGET !== environment.target) throw Error('Target mismatch');
  if (process.env.VERCEL_ENV && (environment.target === 'local' || environment.target !== (process.env.VERCEL_ENV === 'production' ? 'prod' : 'dev'))) throw Error('Hosting mismatch');
  if (environment.readOnly && process.env.DUTY_PRODUCTION_INSPECTION !== 'confirmed') throw Error('Confirmation required');
 } catch {return Response.json({error:'Not configured'},{status:503,headers});}
 // Only the public, RLS-protected client configuration crosses into the browser.
 return Response.json({url,key,...(deploymentOrigin ? {deploymentOrigin} : {})},{headers});
}
