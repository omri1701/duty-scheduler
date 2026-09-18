import {env} from 'cloudflare:workers';
export async function GET(){
 const bindings=env as unknown as Record<string,string|undefined>;
 const url=bindings.SUPABASE_URL??process.env.SUPABASE_URL;
 const key=bindings.SUPABASE_PUBLISHABLE_KEY??process.env.SUPABASE_PUBLISHABLE_KEY;
 if(!url||!key?.startsWith('sb_publishable_'))return Response.json({error:'Not configured'},{status:503});
 // Only the public, RLS-protected client configuration crosses into the browser.
 return Response.json({url,key},{headers:{'Cache-Control':'no-store'}});
}
