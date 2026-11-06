'use client';
import {useEffect, useState} from 'react';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {Balance} from '@/lib/supabase/balance';

// The last balance read per signed-in member, kept for this page's lifetime (owner review
// 2026-11-07): Home and Team show it at once while a newer revision loads, and only the numbers
// that changed move. Never stored on the device.
const cache = new Map<string, {revision: number; value: Balance | null}>();

/** The display projection served by duty_balance: `undefined` until a first answer this session;
 * `null` when the database has no balance RPC (nothing to show). */
export function useBalance(remote: TeamWorkspace): Balance | null | undefined {
  const user = remote.user?.id ?? '', revision = remote.snapshot?.revision, load = remote.balance;
  const [entry, setEntry] = useState(() => cache.get(user));
  // A switch of account never shows the previous member's numbers.
  const [owner, setOwner] = useState(user);
  if (owner !== user) {setOwner(user); setEntry(cache.get(user));}
  // Another screen already read this revision: take its answer.
  const cached = cache.get(user);
  if (owner === user && cached && cached !== entry && cached.revision === revision) setEntry(cached);
  useEffect(() => {
    if (revision == null || !user || cache.get(user)?.revision === revision) return;
    let alive = true;
    // Every published change advances the revision; an older database without the read RPC shows no number.
    const keep = (value: Balance | null) => {const next = {revision, value}; cache.set(user, next); if (alive) setEntry(next);};
    load().then(keep, () => keep(cache.get(user)?.value ?? null));
    return () => {alive = false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is recreated each render; revision is the trigger.
  }, [revision, user]);
  return entry?.value;
}
