'use client';
import {createClient,type SupabaseClient} from '@supabase/supabase-js';
let pending:Promise<SupabaseClient>|undefined;
export function getSupabase(){
 if(!pending)pending=fetch('/api/config',{cache:'no-store'}).then(async response=>{
  if(!response.ok)throw Error('The team connection is not configured yet.');
  const {url,key}=await response.json() as {url:unknown;key:unknown};
  if(typeof url!=='string'||typeof key!=='string'||!key.startsWith('sb_publishable_'))throw Error('Invalid connection configuration.');
  return createClient(url,key,{auth:{flowType:'pkce',detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}});
 }).catch(error=>{pending=undefined;throw error});
 return pending;
}
