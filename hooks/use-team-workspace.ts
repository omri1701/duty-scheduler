'use client';
import {useEffect,useState} from 'react';
import type {User} from '@supabase/supabase-js';
import {getSupabase,signInWithGoogle} from '@/lib/supabase/client';
import {fromSnapshot,schedulePayload,canManage,type Snapshot} from '@/lib/supabase/snapshot';
import {observeSession} from '@/lib/supabase/session';
import {createWorkspace} from '@/lib/supabase/workspace';
import {errorMessage,type DutyClient} from '@/lib/supabase/rpc';
import type {State} from '@/lib/rota/engine';

export function useTeamWorkspace(){
 const [client,setClient]=useState<DutyClient|null>(null),[user,setUser]=useState<User|null>(null),[snapshot,setSnapshot]=useState<Snapshot|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const [workspace]=useState(()=>createWorkspace({snapshot:setSnapshot,saving:setSaving,error:setError}));
 useEffect(()=>{
  let alive=true,unsubscribe=()=>{};
  async function bootstrap(){
   try{
    const query=new URLSearchParams(window.location.search),fragment=new URLSearchParams(window.location.hash.slice(1));
    const authError=query.get('error_description')??fragment.get('error_description');
    if(authError)setError(authError);
    const c=await getSupabase();
    if(!alive)return;
    setClient(c);
    unsubscribe=observeSession(c,{
     clear:()=>{workspace.clear();setUser(null)},
     user:async u=>{setUser(u);await workspace.connect(c,u)},
     error:e=>setError(errorMessage(e,'Could not load the team. Please try again.')),
     ready:()=>setLoading(false),
    });
   }catch(e){if(alive){setError(errorMessage(e,'Could not load the team. Please try again.'));setLoading(false)}}
  }
  void bootstrap();
  return()=>{alive=false;unsubscribe();workspace.clear()};
 },[workspace]);
 useEffect(()=>{
  if(!client||!user)return;
  let alive=true;
  const poll=()=>{if(document.visibilityState==='visible'&&!workspace.isSaving())workspace.refresh().catch(e=>{if(alive)setError(errorMessage(e,'Could not refresh the team. Please try again.'))})};
  const timer=setInterval(poll,30000);window.addEventListener('focus',poll);
  return()=>{alive=false;clearInterval(timer);window.removeEventListener('focus',poll)};
 },[client,user,workspace]);
 const me=snapshot?.members.find(m=>m.id===user?.id);
 return {user,me,snapshot,loading,saving,error,isAdmin:!!snapshot&&!!user&&canManage(snapshot,user.id),clearError:()=>setError(''),state:snapshot&&user?fromSnapshot(snapshot,user.id):null,
  refresh:()=>workspace.refresh(),
  async signIn(){try{setError('');await signInWithGoogle()}catch(e){setError(errorMessage(e,'Could not sign in. Please try again.'))}},
  async signOut(){if(client){try{const {error}=await client.auth.signOut();if(error)setError(error.message)}catch(e){setError(errorMessage(e,'Could not sign out. Please try again.'))}}},
  save:(s:State,publish?:string)=>workspace.mutate('duty_save_schedule',{p_state:schedulePayload(s),p_publish:publish??null}).then(()=>{}),
  constraints:(person:string,days:string[],kind:string,note:string)=>workspace.mutate('duty_set_constraints',{p_member:person,p_days:days,p_kind:kind,p_note:note}).then(()=>{}),
  rename:(name:string)=>workspace.mutate('duty_rename_self',{p_name:name}).then(()=>{}),
  setRole:(person:string,role:string)=>workspace.mutate('duty_set_role',{p_member:person,p_role:role}).then(()=>{}),
  restore:(publication:string)=>workspace.mutate('duty_restore_publication',{p_publication:publication}).then(()=>{}),
  deleteVersion:(publication:string)=>workspace.mutate('duty_delete_publication',{p_publication:publication}).then(()=>{}),
  requestSwap:(from:string,to:string,explanation:string)=>workspace.mutate('duty_request_swap',{p_from:from,p_to:to,p_explanation:explanation}).then(()=>{}),
  async resolveSwap(id:string,action:'accept'|'decline'|'approve'|'reject'|'cancel',overrideReason=''){
   const result=await workspace.mutate('duty_resolve_swap',{p_request:id,p_action:action,p_override_reason:overrideReason});
   if(result==='invalidated')throw Error('This request was invalidated because its published duties are no longer eligible.');
  },
  review:(person:string,status:'approved'|'rejected')=>workspace.mutate('duty_review_member',{p_member:person,p_status:status}).then(()=>{}),
 };
}
export type TeamWorkspace=ReturnType<typeof useTeamWorkspace>;
