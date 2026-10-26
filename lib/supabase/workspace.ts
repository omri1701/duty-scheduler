import type {Session, User} from '@supabase/supabase-js';
import {readSnapshot, type Snapshot} from './snapshot.ts';
import {errorMessage, type DutyClient, type Functions, type MutationArgs, type MutationName} from './rpc.ts';
import {assertWritable, isReadOnly} from './write-policy.ts';

type Scope = {client: DutyClient; id: string; snapshot: Snapshot | null; request: number; bootstrap: Promise<void> | null; read: {sequence: number; promise: Promise<void>} | null; save: Promise<unknown> | null};

async function read(client: DutyClient, token?: string) {
  const request = client.rpc('duty_load');
  if (token) request.setHeader('Authorization', `Bearer ${token}`);
  const {data, error} = await request;
  if (error) throw error;
  return readSnapshot(data);
}

// Each identity owns its requests, snapshot and save lock. Replacing the scope
// prevents old completions (including finally/catch) from touching a new session.
export function createWorkspace(callbacks: {
  snapshot: (snapshot: Snapshot | null) => void;
  saving: (saving: boolean) => void;
  error: (message: string) => void;
}) {
  let scope: Scope | null = null;
  function clear() {
    scope = null;
    callbacks.snapshot(null); callbacks.saving(false);
  }
  async function load(current: Scope) {
    const seq = ++current.request;
    try {
      const snapshot = await read(current.client);
      if (scope !== current || seq !== current.request) return;
      current.snapshot = snapshot; callbacks.snapshot(snapshot);
    } catch (error) {
      if (scope === current && seq === current.request) throw error;
    }
  }
  async function refresh() {
    const current = scope;
    if (!current) return;
    // Give a save dispatched in this turn ownership of its final reload.
    await Promise.resolve();
    if (scope !== current) return;
    // The save owns its final reload. A competing read must not publish an
    // intermediate revision or supersede that reload.
    const pendingSave = current.save;
    if (pendingSave) {await pendingSave.catch(() => {}); return;}
    if (current.bootstrap) {
      try {await current.bootstrap;}
      catch (error) {if (scope === current) throw error;}
      return;
    }
    if (current.read?.sequence === current.request) {await current.read.promise; return;}
    const promise = load(current), sequence = current.request;
    current.read = {sequence, promise};
    try {await promise;}
    finally {if (current.read?.promise === promise) current.read = null;}
  }
  async function prepare(client: DutyClient, session: Session) {
    if (scope?.client === client && scope.id === session.user.id) return undefined;
    // Only the session observer commits this result after verifying the same token.
    return read(client, session.access_token);
  }
  async function connect(client: DutyClient, user: User, initial?: Snapshot) {
    if (scope?.client !== client || scope.id !== user.id) {
      clear();
      const current: Scope = {client, id: user.id, snapshot: null, request: 0, bootstrap: null, read: null, save: null};
      scope = current;
      const name = String(user.user_metadata?.full_name ?? user.email?.split('@')[0] ?? 'Engineer');
      current.bootstrap = (async () => {
        let snapshot = initial ?? await read(client);
        if (scope !== current) return;
        // Presence, not approval/revision, distinguishes registration. Pending,
        // rejected and inactive members already have their own RLS-visible row.
        if (!snapshot.members.some(member => member.id === user.id) && !isReadOnly(client)) {
          assertWritable(client);
          const {error} = await client.rpc('duty_join', {p_name: name});
          if (scope !== current) return;
          if (error) throw error;
          snapshot = await read(client);
          if (scope !== current) return;
        }
        current.snapshot = snapshot; callbacks.snapshot(snapshot);
      })();
      try {await current.bootstrap;}
      catch (error) {if (scope === current) {clear(); throw error;}}
      finally {current.bootstrap = null;}
    } else await refresh();
  }
  function mutate<N extends MutationName>(name: N, args: MutationArgs<N>): Promise<Functions[N]['Returns']> {
    const current = scope;
    if (current) {try {assertWritable(current.client);} catch (error) {return Promise.reject(error);}}
    if (!current || current.snapshot?.revision == null) return Promise.reject(Error('Sign in with an approved account first.'));
    if (current.save) return Promise.reject(Error('Please wait for the current save.'));
    const revision = current.snapshot.revision;
    current.request++; callbacks.saving(true); callbacks.error('');
    const save = (async () => {
      try {
        // Only this path supplies the revision; callers cannot override it.
        const params = {...args, p_revision: revision} as Functions[N]['Args'];
        const {data, error} = await current.client.rpc(name, params);
        if (error) throw error;
        if (scope === current) await load(current);
        return data as Functions[N]['Returns'];
      } catch (error) {
        const message = errorMessage(error, 'Could not save. Please try again.');
        if (scope === current) {
          callbacks.error(message);
          await load(current).catch(() => {});
        }
        throw Error(message);
      } finally {
        if (scope === current) {current.save = null; callbacks.saving(false);}
      }
    })();
    current.save = save;
    return save;
  }
  /** Generation uses its original revision, never mutate()'s latest revision.
   * Share the identity/save lock and final reload with ordinary workspace writes. */
  function captured<T>(revision: number, operation: (client: DutyClient) => Promise<T>, resultRevision?: (result: T) => number): Promise<T> {
    const current = scope;
    if (!current || current.snapshot?.revision !== revision) return Promise.reject(Error('The team data changed. Refresh and review allocation.'));
    try {assertWritable(current.client);} catch (error) {return Promise.reject(error);}
    if (current.save) return Promise.reject(Error('Please wait for the current save.'));
    current.request++; callbacks.saving(true);
    const save = (async () => {
      try {
        const result = await operation(current.client);
        if (scope !== current) throw Error('Your session changed. The result was discarded.');
        // A context read often reconciles nothing. Its authoritative unchanged
        // revision proves the accepted calendar is current; avoid a duplicate load.
        if (!resultRevision || resultRevision(result) !== current.snapshot?.revision) await load(current);
        return result;
      } catch (error) {
        if (scope === current) await load(current).catch(() => {});
        throw error;
      } finally {
        if (scope === current) {current.save = null; callbacks.saving(false);}
      }
    })();
    current.save = save;
    return save;
  }
  return {connect, prepare, clear, refresh, mutate, captured, isSaving: () => !!scope?.save};
}
