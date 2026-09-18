'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {User,SupabaseClient} from '@supabase/supabase-js';
import {getSupabase,signInWithGoogle} from '@/lib/supabase/client';
import {fromSnapshot,schedulePayload,canManage,type Snapshot} from '@/lib/supabase/snapshot';
import type {State} from '@/lib/rota/engine';
export function useTeamWorkspace(){
 const [client,setClient]=useState<SupabaseClient|null>(null),[user,setUser]=useState<User|null>(null),[snapshot,setSnapshot]=useState<Snapshot|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const raw=useRef<Snapshot|null>(null),lock=useRef(false),identity=useRef<string|null>(null),request=useRef(0);
 const refresh=useCallback(async(c:SupabaseClient,id:string)=>{const seq=++request.current;const {data,error}=await c.rpc('duty_load');if(error)throw error;if(identity.current===id&&seq===request.current){raw.current=data as Snapshot;setSnapshot(data as Snapshot)}},[]);
 useEffect(()=>{let alive=true,unsubscribe=()=>{};
 async function bootstrap(){try{const query=new URLSearchParams(window.location.search),fragment=new URLSearchParams(window.location.hash.slice(1));const authError=query.get('error_description')??fragment.get('error_description');if(authError)setError(authError);const c=await getSupabase();if(!alive)return;setClient(c);
  async function sync(){const {data,error}=await c.auth.getUser();if(!alive)return;const u=data.user;if(error&&error.name!=='AuthSessionMissingError')throw error;if(!u){identity.current=null;raw.current=null;setUser(null);setSnapshot(null);setLoading(false);return}if(error)throw error;identity.current=u.id;setUser(u);const name=String(u.user_metadata?.full_name??u.email?.split('@')[0]??'Engineer');const joined=await c.rpc('duty_join',{p_name:name});if(joined.error)throw joined.error;await refresh(c,u.id);if(alive)setLoading(false)}
  await sync();const {data:{subscription}}=c.auth.onAuthStateChange((event)=>{if(event==='SIGNED_OUT'){identity.current=null;raw.current=null;setUser(null);setSnapshot(null)}else if(event==='SIGNED_IN'||event==='USER_UPDATED'){setTimeout(()=>{if(alive)sync().catch(e=>{setError(e.message);setLoading(false)})},0)}});unsubscribe=()=>subscription.unsubscribe();
 }catch(e){if(alive){setError(e instanceof Error?e.message:String(e));setLoading(false)}}}
 bootstrap();return()=>{alive=false;identity.current=null;unsubscribe()};
 },[refresh]);
 useEffect(()=>{if(!client||!user)return;const poll=()=>{if(document.visibilityState==='visible'&&!lock.current)refresh(client,user.id).catch(e=>setError(e.message))};const timer=setInterval(poll,30000);window.addEventListener('focus',poll);return()=>{clearInterval(timer);window.removeEventListener('focus',poll)}},[client,user,refresh]);
 async function mutate(operation:(c:SupabaseClient,revision:number)=>PromiseLike<{error:{message:string;code?:string}|null}>){
  if(!client||!user||snapshot?.revision==null)throw Error('Sign in with an approved account first.');
  if(lock.current)throw Error('Please wait for the current save.');
  lock.current=true;setSaving(true);setError('');request.current++;
  try{const r=await operation(client,snapshot.revision);if(r.error)throw r.error;await refresh(client,user.id)}catch(e){const message=(e as {message?:string}).message??'Could not save. Please try again.';setError(message);await refresh(client,user.id).catch(()=>{});throw Error(message)}finally{lock.current=false;setSaving(false)}
 }
 const me=snapshot?.members.find(m=>m.id===user?.id);
 return {user,me,snapshot,loading,saving,error,isAdmin:!!snapshot&&!!user&&canManage(snapshot,user.id),clearError:()=>setError(''),state:snapshot&&user?fromSnapshot(snapshot,user.id):null,
  async refresh(){if(client&&user)await refresh(client,user.id)},
  async signIn(){try{setError('');await signInWithGoogle()}catch(e){setError((e as Error).message)}},
  async signOut(){if(client){const {error}=await client.auth.signOut();if(error)setError(error.message)}},
  save:(s:State,publish?:string)=>mutate((c,revision)=>c.rpc('duty_save_schedule',{p_state:schedulePayload(s),p_revision:revision,p_publish:publish??null})),
  constraints:(person:string,days:string[],kind:string,note:string)=>mutate((c,revision)=>c.rpc('duty_set_constraints',{p_member:person,p_days:days,p_kind:kind,p_note:note,p_revision:revision})),
  rename:(name:string)=>mutate((c,revision)=>c.rpc('duty_rename_self',{p_name:name,p_revision:revision})),
  setRole:(person:string,role:string)=>mutate((c,revision)=>c.rpc('duty_set_role',{p_member:person,p_role:role,p_revision:revision})),
  restore:(publication:string)=>mutate((c,revision)=>c.rpc('duty_restore_publication',{p_publication:publication,p_revision:revision})),
  deleteVersion:(publication:string)=>mutate((c,revision)=>c.rpc('duty_delete_publication',{p_publication:publication,p_revision:revision})),
  review:(person:string,status:'approved'|'rejected')=>mutate((c,revision)=>c.rpc('duty_review_member',{p_member:person,p_status:status,p_revision:revision})),
 };
}
export type TeamWorkspace=ReturnType<typeof useTeamWorkspace>;
