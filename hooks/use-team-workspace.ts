'use client';
import {useEffect,useMemo,useState} from 'react';
import type {User} from '@supabase/supabase-js';
import {getSupabase,getEnvironment,signInWithGoogle,signInLocally,completeInspectionLogin} from '@/lib/supabase/client';
import type {Environment} from '@/lib/supabase/environment';
import {fromSnapshot,schedulePayload,canManage,readSnapshot,type Snapshot} from '@/lib/supabase/snapshot';
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
import type {PublishedEdit,WeekendEdit} from '@/lib/supabase/published-edit';
import {swapAvailability} from '@/lib/supabase/swaps';
import {editReturns} from '@/lib/supabase/published-edit';
import {replannedVersions} from '@/lib/supabase/versions';
import {forgetCalendarLinks} from '@/lib/supabase/calendar';
import {readNotificationState, settingsPayload, type NotificationSettings} from '@/lib/push/settings';
import type {DeviceSubscription} from '@/lib/push/browser';

// Offline (decision 2026-11-06): the last snapshot each member loaded stays on the device, so the
// schedule is viewable without a network; every write stays disabled until the server answers.
const SNAPSHOT_KEY=(userId:string)=>`duty-snapshot:${userId}`;
const isNetworkError=(e:unknown)=>(typeof navigator!=='undefined'&&!navigator.onLine)||/Failed to fetch|NetworkError|Load failed|network|not configured yet/i.test(errorMessage(e,''));
function readCachedSnapshot(userId:string):Snapshot|null{try{const raw=localStorage.getItem(SNAPSHOT_KEY(userId));return raw?readSnapshot(JSON.parse(raw)):null}catch{return null}}

export function useTeamWorkspace(){
 const [environment,setEnvironment]=useState<Environment|null>(null);
 const [client,setClient]=useState<DutyClient|null>(null),[user,setUser]=useState<User|null>(null),[snapshot,setSnapshot]=useState<Snapshot|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const [workspace]=useState(()=>createWorkspace({snapshot:setSnapshot,saving:setSaving,error:setError}));
 const [online,setOnline]=useState(true),[cached,setCached]=useState<{userId:string;snapshot:Snapshot}|null>(null);
 useEffect(()=>{
  const sync=()=>setOnline(navigator.onLine);
  const on=()=>{sync();workspace.refresh().catch(()=>{})};
  sync();
  window.addEventListener('online',on);window.addEventListener('offline',sync);
  return()=>{window.removeEventListener('online',on);window.removeEventListener('offline',sync)};
 },[workspace]);
 useEffect(()=>{
  if(!snapshot||!user)return;
  try{localStorage.setItem(SNAPSHOT_KEY(user.id),JSON.stringify(snapshot))}catch{}
 },[snapshot,user]);
 useEffect(()=>{
  let alive=true,unsubscribe=()=>{};
  // No server: the session's own user and their last snapshot, read-only.
  async function fallback(c:DutyClient|null){
   try{
    const session=c?(await c.auth.getSession()).data.session:null;
    const copy=session?readCachedSnapshot(session.user.id):null;
    if(alive&&session&&copy){setUser(session.user);setCached({userId:session.user.id,snapshot:copy});setError('')}
   }catch{}
  }
  async function bootstrap(){
   let c:DutyClient|null=null;
   try{
    const query=new URLSearchParams(window.location.search),fragment=new URLSearchParams(window.location.hash.slice(1));
    const authError=query.get('error_description')??fragment.get('error_description');
    if(authError)setError(authError);
    c=await getSupabase();
    if(!alive)return;
    setClient(c);
    setEnvironment(await getEnvironment());
    const connected=c;
    unsubscribe=observeSession(connected,{
     clear:()=>{workspace.clear();setUser(null);setLoading(true)},
     prepare:s=>workspace.prepare(connected,s),
     user:async (u,initial)=>{setCached(null);setUser(u);await workspace.connect(connected,u,initial)},
     error:e=>{setError(errorMessage(e,'Could not load the team. Please try again.'));if(isNetworkError(e))void fallback(connected)},
     ready:()=>setLoading(false),
    });
   }catch(e){if(alive){setError(errorMessage(e,'Could not load the team. Please try again.'));if(isNetworkError(e))await fallback(c);setLoading(false)}}
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
 // The live snapshot, or the device's last copy for this member while the server is unreachable.
 const offline=!snapshot&&!!user&&cached?.userId===user.id;
 const shown=snapshot??(offline?cached!.snapshot:null);
 const me=shown?.members.find(m=>m.id===user?.id);
 // Personal settings (decision 2026-11-06): direct checked RPCs without the workspace
 // revision, so they never conflict with schedule edits or refresh the team.
 const personal=useMemo(()=>({
  async setLanguage(language:'en'|'he'){if(client&&!environment?.readOnly&&user){const {error}=await client.rpc('duty_set_language',{p_language:language});if(error)throw error}},
  async notificationSettings(){if(!client)throw Error('Not connected');const {data,error}=await client.rpc('duty_notification_settings',{});if(error)throw error;return readNotificationState(data)},
  async saveNotificationSettings(settings:NotificationSettings){if(!client)throw Error('Not connected');const {data,error}=await client.rpc('duty_set_notification_settings',{p_settings:settingsPayload(settings)});if(error)throw error;return readNotificationState(data)},
  async saveDevice(device:DeviceSubscription){if(!client)throw Error('Not connected');const {error}=await client.rpc('duty_save_push_subscription',{p_endpoint:device.endpoint,p_p256dh:device.p256dh,p_auth:device.auth});if(error)throw error},
  async removeDevice(endpoint:string){if(!client)throw Error('Not connected');const {error}=await client.rpc('duty_delete_push_subscription',{p_endpoint:endpoint});if(error)throw error},
  }),[client,environment,user]);
 return {user,me,snapshot:shown,loading,saving,error:offline?'':error,environment,offline:offline||!online,readOnly:(environment?.readOnly??true)||offline,isAdmin:!!shown&&!!user&&canManage(shown,user.id),clearError:()=>setError(''),state:shown&&user?fromSnapshot(shown,user.id):null,
  refresh:()=>workspace.refresh(),
  // Display-only projection; read where it is shown, never at startup.
  balance:()=>client?readBalance(client):Promise.reject(Error('Not connected')),
  replannedVersions:(month:string)=>client?replannedVersions(client,month):Promise.reject(Error('Not connected')),
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
  async signOut(){forgetCalendarLinks();if(client){try{const {error}=await signOutSafely(client);if(error)setError(error.message)}catch(e){setError(errorMessage(e,'Could not sign out. Please try again.'))}}},
  save:(s:State,publish?:string,month?:string,reviewedLocks?:string[])=>workspace.mutate('duty_save_schedule',{p_state:schedulePayload(s,month??publish,!!publish,reviewedLocks),p_publish:publish??null}).then(()=>{}),
  constraints:(person:string,days:string[],kind:string,note:string)=>workspace.mutate('duty_set_constraints',{p_member:person,p_days:days,p_kind:kind,p_note:note}).then(()=>{}),
  rename:(name:string)=>workspace.mutate('duty_rename_self',{p_name:name}).then(()=>{}),
  setColor:(color:string)=>workspace.mutate('duty_set_color',{p_color:color}).then(()=>{}),
  personal,

  setRole:(person:string,role:string)=>workspace.mutate('duty_set_role',{p_member:person,p_role:role}).then(()=>{}),
  setNoWeekends:(person:string,noWeekends:boolean)=>workspace.mutate('duty_set_no_weekends',{p_member:person,p_no_weekends:noWeekends}).then(()=>{}),
  restore:(publication:string)=>workspace.mutate('duty_restore_publication',{p_publication:publication}).then(()=>{}),
  cancelDraft:(month:string)=>workspace.mutate('duty_cancel_draft',{p_month:month}).then(()=>{}),
  deleteVersion:(publication:string)=>workspace.mutate('duty_delete_publication',{p_publication:publication}).then(()=>{}),
  // Read-only: whose unavailability blocks a swap, rechecked by every swap write.
  swapAvailability:(from:string,to:string)=>client?swapAvailability(client,from,to):Promise.reject(Error('Not connected')),
  editReturns:(publication:string,day:string)=>client?editReturns(client,publication,day):Promise.reject(Error('Not connected')),
  requestSwap:(from:string,to:string,explanation:string)=>workspace.mutate('duty_request_swap',{p_from:from,p_to:to,p_explanation:explanation}).then(()=>{}),
  async resolveSwap(id:string,action:'accept'|'decline'|'approve'|'reject'|'cancel',overrideReason=''){
   const result=await workspace.mutate('duty_resolve_swap',{p_request:id,p_action:action,p_override_reason:overrideReason});
   if(result==='invalidated')throw Error('This request was invalidated because its published duties changed or are no longer eligible.');
  },
  editPublishedDuty:(publication:string,day:string,edit:PublishedEdit)=>workspace.mutate('duty_edit_published_duty',{p_publication:publication,p_day:day,p_primary:edit.primary,p_extra_points:edit.extra,p_saturday_extra_points:edit.saturdayExtra,p_kind:edit.kind,p_override_reason:edit.overrideReason.trim()}),
  editPublishedWeekend:(publication:string,friday:string,edit:WeekendEdit)=>workspace.mutate('duty_edit_published_weekend',{p_publication:publication,p_friday:friday,p_friday_primary:edit.fridayPrimary,p_friday_extra:edit.fridayExtra,p_saturday_primary:edit.saturdayPrimary,p_saturday_extra:edit.saturdayExtra,p_kind:edit.kind,p_override_reason:edit.overrideReason.trim()}),
  review:(person:string,status:'approved'|'rejected')=>workspace.mutate('duty_review_member',{p_member:person,p_status:status}).then(()=>{}),
  addTemporaryMember:(name:string)=>workspace.mutate('duty_add_temporary_member',{p_name:name}),
  renameTemporaryMember:(person:string,name:string)=>workspace.mutate('duty_rename_temporary_member',{p_member:person,p_name:name}).then(()=>{}),
 };
}
export type TeamWorkspace=ReturnType<typeof useTeamWorkspace>;
