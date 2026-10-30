'use client';
import {useEffect,useState} from 'react';
import type {User} from '@supabase/supabase-js';
import {getSupabase,getEnvironment,signInWithGoogle,signInLocally,completeInspectionLogin} from '@/lib/supabase/client';
import type {Environment} from '@/lib/supabase/environment';
import {fromSnapshot,schedulePayload,canManage,type Snapshot} from '@/lib/supabase/snapshot';
import {observeSession} from '@/lib/supabase/session';
import {createWorkspace} from '@/lib/supabase/workspace';
import {errorMessage,type DutyClient} from '@/lib/supabase/rpc';
import {signOutSafely} from '@/lib/supabase/write-policy';
import type {State} from '@/lib/rota/engine';
import {generationContext, confirmAllocation, saveGeneration, type GenerationContext} from '@/lib/supabase/generation';
import type {AllocationDraft} from '@/lib/allocation/types';
import type {Approval, GenerationInput} from '@/lib/scheduling/types';
import type {PrimaryAssignments} from '@/lib/scheduling/validate';
import {balance as readBalance} from '@/lib/supabase/balance';

export function useTeamWorkspace(){
 const [environment,setEnvironment]=useState<Environment|null>(null);
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
    setEnvironment(await getEnvironment());
    unsubscribe=observeSession(c,{
     clear:()=>{workspace.clear();setUser(null);setLoading(true)},
     prepare:s=>workspace.prepare(c,s),
     user:async (u,initial)=>{setUser(u);await workspace.connect(c,u,initial)},
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
  const timer=setInterval(poll,30000);
  return()=>{alive=false;clearInterval(timer)};
 },[client,user,workspace]);
 const me=snapshot?.members.find(m=>m.id===user?.id);
 return {user,me,snapshot,loading,saving,error,environment,readOnly:environment?.readOnly??true,isAdmin:!!snapshot&&!!user&&canManage(snapshot,user.id),clearError:()=>setError(''),state:snapshot&&user?fromSnapshot(snapshot,user.id):null,
  refresh:()=>workspace.refresh(),
  // Display-only projection; read where it is shown, never at startup.
  balance:()=>client?readBalance(client):Promise.reject(Error('Not connected')),
  generationContext:(month:string,revision:number)=>workspace.captured(revision,c=>generationContext(c,month,revision),result=>result.revision),
  openGenerationMonth:(context:GenerationContext,s:State)=>workspace.captured(context.revision,async c=>{
   const {error}=await c.rpc('duty_save_schedule',{p_state:schedulePayload(s,context.input.schedule.month),p_publish:null,p_revision:context.revision});
   if(error)throw error;
   return generationContext(c,context.input.schedule.month,context.revision+1);
  }),
  confirmAllocation:(context:GenerationContext,draft:AllocationDraft,locks?:GenerationInput['locks'],approvals?:Approval[])=>workspace.captured(context.revision,c=>confirmAllocation(c,context,draft,locks,approvals)),
  saveGeneration:(context:GenerationContext,assignments:PrimaryAssignments,seed:number)=>workspace.captured(context.revision,c=>saveGeneration(c,context,assignments,seed)),
  async signIn(){try{setError('');await signInWithGoogle()}catch(e){setError(errorMessage(e,'Could not sign in. Please try again.'))}},
  async signInLocal(email:string,password:string){try{setError('');await signInLocally(email,password)}catch(e){setError(errorMessage(e,'Could not sign in. Please try again.'))}},
  async completeInspection(returnUrl:string){try{setError('');await completeInspectionLogin(returnUrl)}catch{setError('Could not complete inspection login. Start Google sign-in again.')}},
  async signOut(){if(client){try{const {error}=await signOutSafely(client);if(error)setError(error.message)}catch(e){setError(errorMessage(e,'Could not sign out. Please try again.'))}}},
  save:(s:State,publish?:string,month?:string,reviewedLocks?:string[])=>workspace.mutate('duty_save_schedule',{p_state:schedulePayload(s,month??publish,!!publish,reviewedLocks),p_publish:publish??null}).then(()=>{}),
  constraints:(person:string,days:string[],kind:string,note:string)=>workspace.mutate('duty_set_constraints',{p_member:person,p_days:days,p_kind:kind,p_note:note}).then(()=>{}),
  rename:(name:string)=>workspace.mutate('duty_rename_self',{p_name:name}).then(()=>{}),
  setRole:(person:string,role:string)=>workspace.mutate('duty_set_role',{p_member:person,p_role:role}).then(()=>{}),
  restore:(publication:string)=>workspace.mutate('duty_restore_publication',{p_publication:publication}).then(()=>{}),
  cancelDraft:(month:string)=>workspace.mutate('duty_cancel_draft',{p_month:month}).then(()=>{}),
  deleteVersion:(publication:string)=>workspace.mutate('duty_delete_publication',{p_publication:publication}).then(()=>{}),
  requestSwap:(from:string,to:string,explanation:string)=>workspace.mutate('duty_request_swap',{p_from:from,p_to:to,p_explanation:explanation}).then(()=>{}),
  async resolveSwap(id:string,action:'accept'|'decline'|'approve'|'reject'|'cancel',overrideReason=''){
   const result=await workspace.mutate('duty_resolve_swap',{p_request:id,p_action:action,p_override_reason:overrideReason});
   if(result==='invalidated')throw Error('This request was invalidated because its published duties are no longer eligible.');
  },
  review:(person:string,status:'approved'|'rejected')=>workspace.mutate('duty_review_member',{p_member:person,p_status:status}).then(()=>{}),
  addTemporaryMember:(name:string)=>workspace.mutate('duty_add_temporary_member',{p_name:name}),
  renameTemporaryMember:(person:string,name:string)=>workspace.mutate('duty_rename_temporary_member',{p_member:person,p_name:name}).then(()=>{}),
 };
}
export type TeamWorkspace=ReturnType<typeof useTeamWorkspace>;
