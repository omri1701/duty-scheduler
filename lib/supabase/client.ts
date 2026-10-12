'use client';
import {createClient} from '@supabase/supabase-js';
import type {Database,DutyClient} from './rpc.ts';
type Connection = {client: DutyClient; url: string; key: string};
let pending:Promise<Connection>|undefined;
function getConnection(){
 if(!pending)pending=fetch('/api/config',{cache:'no-store'}).then(async response=>{
  if(!response.ok)throw Error('The team connection is not configured yet.');
  const config: unknown = await response.json();
  if(typeof config!=='object'||config===null||!('url' in config)||!('key' in config))throw Error('Invalid connection configuration.');
  const {url,key}=config;
  if(typeof url!=='string'||typeof key!=='string'||!key.startsWith('sb_publishable_'))throw Error('Invalid connection configuration.');
  return {url,key,client:createClient<Database>(url,key,{auth:{flowType:'pkce',detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}})};
 }).catch(error=>{pending=undefined;throw error});
 return pending;
}
export async function getSupabase(): Promise<DutyClient>{return (await getConnection()).client}

export async function signInWithGoogle(){
 const {client,url,key}=await getConnection();
 const response=await fetch(url+'/auth/v1/settings',{headers:{apikey:key},cache:'no-store'});
 if(!response.ok)throw Error('Could not check Google sign-in. Please try again.');
 const settings=await response.json() as {external?:{google?:boolean}};
 if(settings.external?.google!==true)throw Error('Google sign-in is not enabled yet. The manager needs to finish the Google setup in Supabase.');
 const {error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin+'/'}});
 if(error)throw error;
}
