import type {Session, User} from '@supabase/supabase-js';
import type {DutyClient} from './rpc.ts';

// Storage supplies a routing hint, never an authenticated identity. Verification
// and optional RLS reads use the same token; nothing is committed before both finish.
export function observeSession<T = undefined>(client: DutyClient, callbacks: {
  clear: () => void;
  prepare?: (session: Session) => Promise<T>;
  user: (user: User, prepared: T | undefined) => Promise<void>;
  error: (error: unknown) => void;
  ready: () => void;
}) {
  let alive = true, sequence = 0, identity: string | null = null;
  let announced: string | null | undefined, token: string | undefined;
  let pending: Promise<void> | null = null;
  function clear() {
    sequence++; identity = null; token = undefined; pending = null;
    callbacks.clear();
  }
  function refresh(): Promise<void> {
    if (!alive) return Promise.resolve();
    if (pending) return pending;
    const seq = sequence;
    // All SDK work stays outside onAuthStateChange (including getSession).
    const work = new Promise<void>(resolve => {setTimeout(resolve, 0);}).then(async () => {
      try {
        if (!alive || seq !== sequence) return;
        const {data: {session}, error: sessionError} = await client.auth.getSession();
        if (!alive || seq !== sequence) return;
        if (sessionError) throw sessionError;
        if (!session) {announced = null; clear(); callbacks.ready(); return;}
        announced = session.user.id; token = session.access_token;
        const [{data, error}, prepared] = await Promise.all([
          client.auth.getUser(session.access_token), callbacks.prepare?.(session),
        ]);
        if (!alive || seq !== sequence) return;
        if (error && error.name !== 'AuthSessionMissingError') throw error;
        if (!data.user) {clear(); callbacks.ready(); return;}
        if (error) throw error;
        if (data.user.id !== session.user.id) throw Error('The sign-in identity changed. Please try again.');
        identity = data.user.id;
        await callbacks.user(data.user, prepared);
        if (alive && seq === sequence) callbacks.ready();
      } catch (error) {
        if (alive && seq === sequence) {clear(); callbacks.error(error); callbacks.ready();}
      }
    }).finally(() => {if (pending === work) pending = null;});
    pending = work;
    return work;
  }
  const {data: {subscription}} = client.auth.onAuthStateChange((event, session) => {
    if (!alive) return;
    if (event === 'SIGNED_OUT') {
      announced = null; clear(); callbacks.ready();
    } else if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'USER_UPDATED' || event === 'TOKEN_REFRESHED') {
      const next = session?.user.id ?? null;
      if (event === 'USER_UPDATED' || (announced !== undefined && next !== announced)) clear();
      else if (event === 'SIGNED_IN' && token && token !== session?.access_token) clear();
      announced = next;
      // A same-user refresh does not discard the verified workspace. Resume
      // events still explicitly reverify, even if the token has not changed.
      if (event === 'TOKEN_REFRESHED' && identity === next) {token = session?.access_token; return;}
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && identity === next && token === session?.access_token) return;
      void refresh();
    }
  });
  const resume = () => {if (typeof document !== 'undefined' && document.visibilityState === 'visible') void refresh();};
  const browser = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
  browser?.addEventListener('focus', resume);
  browser?.addEventListener('visibilitychange', resume);
  void refresh();
  return Object.assign(() => {
    alive = false; subscription.unsubscribe();
    browser?.removeEventListener('focus', resume);
    browser?.removeEventListener('visibilitychange', resume);
    clear();
  }, {refresh});
}
