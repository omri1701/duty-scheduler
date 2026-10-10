import type {User} from '@supabase/supabase-js';
import {readSnapshot, type Snapshot} from './snapshot.ts';
import {errorMessage, type DutyClient, type Functions, type MutationArgs, type MutationName} from './rpc.ts';

type Scope = {client: DutyClient; id: string; snapshot: Snapshot | null; request: number; joining: Promise<void>; save: Promise<unknown> | null};

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
      const {data, error} = await current.client.rpc('duty_load');
      if (scope !== current || seq !== current.request) return;
      if (error) throw error;
      const snapshot = readSnapshot(data);
      current.snapshot = snapshot; callbacks.snapshot(snapshot);
    } catch (error) {
      if (scope === current && seq === current.request) throw error;
    }
  }
  async function refresh() {
    const current = scope;
    if (!current) return;
    // The save owns its final reload. A competing read must not publish an
    // intermediate revision or supersede that reload.
    const pendingSave = current.save;
    if (pendingSave) {await pendingSave.catch(() => {}); return;}
    try {await current.joining;}
    catch (error) {if (scope === current) throw error; return;}
    if (scope !== current) return;
    if (current.save) {await current.save.catch(() => {}); return;}
    await load(current);
  }
  async function connect(client: DutyClient, user: User) {
    if (scope?.client !== client || scope.id !== user.id) {
      clear();
      const current: Scope = {client, id: user.id, snapshot: null, request: 0, joining: Promise.resolve(), save: null};
      scope = current;
      const name = String(user.user_metadata?.full_name ?? user.email?.split('@')[0] ?? 'Engineer');
      current.joining = (async () => {
        const {error} = await client.rpc('duty_join', {p_name: name});
        if (scope === current && error) throw error;
      })();
      try {await refresh();}
      catch (error) {if (scope === current) {clear(); throw error;}}
    } else await refresh();
  }
  function mutate<N extends MutationName>(name: N, args: MutationArgs<N>): Promise<Functions[N]['Returns']> {
    const current = scope;
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
  return {connect, clear, refresh, mutate, isSaving: () => !!scope?.save};
}
