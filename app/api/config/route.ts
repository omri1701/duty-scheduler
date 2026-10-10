export const dynamic = 'force-dynamic';

export async function GET(){
 const url=process.env.SUPABASE_URL;
 const key=process.env.SUPABASE_PUBLISHABLE_KEY;
 const headers={'Cache-Control':'no-store'};
 if(!url||!key?.startsWith('sb_publishable_'))return Response.json({error:'Not configured'},{status:503,headers});
 // Only the public, RLS-protected client configuration crosses into the browser.
 return Response.json({url,key},{headers});
}
