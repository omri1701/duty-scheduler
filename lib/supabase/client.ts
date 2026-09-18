'use client';
import {createClient,type SupabaseClient} from '@supabase/supabase-js';
let configuration:{url:string;key:string}|undefined;
let pending:Promise<SupabaseClient>|undefined;
export function getSupabase(){
 if(!pending)pending=fetch('/api/config',{cache:'no-store'}).then(async response=>{
  if(!response.ok)throw Error('The team connection is not configured yet.');
  const {url,key}=await response.json() as {url:unknown;key:unknown};
  if(typeof url!=='string'||typeof key!=='string'||!key.startsWith('sb_publishable_'))throw Error('Invalid connection configuration.');
  configuration={url,key};
  return createClient(url,key,{auth:{flowType:'pkce',detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}});
 }).catch(error=>{pending=undefined;throw error});
 return pending;
}

export async function signInWithGoogle(){
 const client=await getSupabase();
 const {url,key}=configuration!;
 const response=await fetch(url+'/auth/v1/settings',{headers:{apikey:key},cache:'no-store'});
 if(!response.ok)throw Error('Could not check Google sign-in. Please try again.');
 const settings=await response.json() as {external?:{google?:boolean}};
 if(settings.external?.google!==true)throw Error('Google sign-in is not enabled yet. The manager needs to finish the Google setup in Supabase.');
 const {error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin+'/'}});
 if(error)throw error;
}
