import type {User} from '@supabase/supabase-js';
import type {DutyClient} from './rpc.ts';

// Subscribe before the initial verification. Never await Supabase work inside
// an auth callback: it runs under the SDK's session lock.
export function observeSession(client: DutyClient, callbacks: {
  clear: () => void;
  user: (user: User) => Promise<void>;
  error: (error: unknown) => void;
  ready: () => void;
}) {
  let alive = true, sequence = 0, identity: string | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  async function verify(seq: number) {
    try {
      const {data, error} = await client.auth.getUser();
      if (!alive || seq !== sequence) return;
      if (error && error.name !== 'AuthSessionMissingError') throw error;
      if (!data.user) {identity = null; callbacks.clear();}
      else {
        if (error) throw error;
        identity = data.user.id;
        await callbacks.user(data.user);
      }
      if (alive && seq === sequence) callbacks.ready();
    } catch (error) {
      if (alive && seq === sequence) {callbacks.error(error); callbacks.ready();}
    }
  }
  const {data: {subscription}} = client.auth.onAuthStateChange((event, session) => {
    if (!alive) return;
    if (event === 'SIGNED_OUT') {
      sequence++; identity = null; callbacks.clear(); callbacks.ready();
    } else if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
      const seq = ++sequence;
      if (identity !== session?.user.id) {identity = null; callbacks.clear();}
      const timer = setTimeout(() => {timers.delete(timer); if (alive && seq === sequence) void verify(seq);}, 0);
      timers.add(timer);
    }
  });
  void verify(++sequence);
  return () => {
    alive = false; sequence++; subscription.unsubscribe();
    for (const timer of timers) clearTimeout(timer);
    callbacks.clear();
  };
}
