'use client';
import {createClient} from '@supabase/supabase-js';
import type {Database,DutyClient} from './rpc.ts';
import {resolveEnvironment, validatePublicKey, type Environment} from './environment.ts';
import {guardedFetch, registerEnvironment} from './write-policy.ts';
type Connection = {client: DutyClient; url: string; key: string; environment: Environment};
let pending:Promise<Connection>|undefined;
function getConnection(){
 if(!pending)pending=fetch('/api/config',{cache:'no-store'}).then(async response=>{
  if(!response.ok)throw Error('The team connection is not configured yet.');
  const config: unknown = await response.json();
  if(typeof config!=='object'||config===null||!('url' in config)||!('key' in config))throw Error('Invalid connection configuration.');
  const {url,key}=config;
  if(typeof url!=='string'||typeof key!=='string')throw Error('Invalid connection configuration.');
  let environment: Environment, api=url;
  try {
   validatePublicKey(url,key);
   const deploymentOrigin = 'deploymentOrigin' in config && typeof config.deploymentOrigin === 'string' ? config.deploymentOrigin : undefined;
   const devOrigin = 'devOrigin' in config && typeof config.devOrigin === 'string' ? config.devOrigin : undefined;
   const localTunnel = 'localTunnel' in config && typeof config.localTunnel === 'string' ? config.localTunnel : undefined;
   environment=resolveEnvironment(url,window.location.origin,deploymentOrigin,devOrigin,localTunnel);
   // On the LOCAL phone tunnel, Next proxies the loopback API same-origin.
   if(environment.target==='local'&&localTunnel!==undefined&&window.location.origin===localTunnel)api=window.location.origin;
  } catch {throw Error('Invalid connection configuration.');}
  const client=createClient<Database>(api,key,{global:{fetch:guardedFetch(api,environment)},auth:{storageKey:environment.storageKey,flowType:'pkce',detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}});
  registerEnvironment(client,environment);
  return {url,key,client,environment};
 }).catch(error=>{pending=undefined;throw error});
 return pending;
}
export async function getSupabase(): Promise<DutyClient>{return (await getConnection()).client}
export async function getEnvironment(){return (await getConnection()).environment}
export async function signInLocally(email: string,password: string){
 const {client,environment}=await getConnection();
 if(environment.target!=='local')throw Error('Password login is available only for LOCAL.');
 const {error}=await client.auth.signInWithPassword({email,password});
 if(error)throw error;
}

export async function signInWithGoogle(){
 const {client,url,key,environment}=await getConnection();
 if(environment.target==='local')throw Error('Use a local test account.');
 const response=await fetch(url+'/auth/v1/settings',{headers:{apikey:key},cache:'no-store'});
 if(!response.ok)throw Error('Could not check Google sign-in. Please try again.');
 const settings=await response.json() as {external?:{google?:boolean}};
 if(settings.external?.google!==true)throw Error('Google sign-in is not enabled yet. The manager needs to finish the Google setup in Supabase.');
 const {data,error}=await client.auth.signInWithOAuth({provider:'google',options:{queryParams:{prompt:'select_account'},redirectTo:environment.readOnly?'https://duty-scheduler-prod.vercel.app/':window.location.origin+'/',skipBrowserRedirect:environment.readOnly}});
 if(error)throw error;
 if(environment.readOnly&&data.url)window.open(data.url,'_blank','noopener,noreferrer');
}

export async function completeInspectionLogin(returnUrl:string){
 const {client,environment}=await getConnection();
 if(!environment.readOnly)throw Error('Not an inspection session.');
 const callback=new URL(returnUrl);
 const code=callback.searchParams.get('code');
 if(callback.origin!=='https://duty-scheduler-prod.vercel.app'||callback.pathname!=='/'||!code||callback.username||callback.password)throw Error('Invalid Google return URL.');
 // The one-time code only works with this localhost session's PKCE verifier.
 const flowId=callback.searchParams.get('sb_flow_id');
 const {error}=await client.auth.exchangeCodeForSession(code,flowId?{flowId}:undefined);
 if(error)throw error;
}
