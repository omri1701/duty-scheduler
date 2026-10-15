'use client';
import {useRef, useState} from 'react';
import {toast} from 'sonner';
import type {Engineer} from '@/lib/rota/engine';

const sameOrder = (ids: string[], team: Engineer[]) =>
 ids.length === team.length && ids.every((id, i) => id === team[i].id);

// Store only order: profile/role/active changes always come from current props.
export function useOptimisticTeam(team: Engineer[], revision: number, readOnly: boolean,
 save: (team: Engineer[]) => boolean | void | Promise<boolean | void>, failureMessage: string) {
 const [optimistic, setOptimistic] = useState<{ids: string[]; revision: number} | null>(null);
 const [saving, setSaving] = useState(false);
 const lock = useRef(false);
 const reconciled = !!optimistic && (sameOrder(optimistic.ids, team) || revision > optimistic.revision || readOnly);
 const byId = new Map(team.map(person => [person.id, person]));
 const displayed = optimistic && !reconciled
  ? [...optimistic.ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), ...team.filter(p => !optimistic.ids.includes(p.id))]
  : team;
 // Retire the overlay during render so there is no stale frame or effect gap.
 // A newer differing revision is an external update, never an implicit retry.
 if (reconciled) setOptimistic(null);
 async function reorder(next: Engineer[]) {
  if (lock.current || optimistic || readOnly) return;
  const operation = {ids: next.map(p => p.id), revision};
  lock.current = true;
  setSaving(true);
  setOptimistic(operation);
  try {
   if (await save(next) === false) {
    setOptimistic(current => current === operation ? null : current);
    toast.error(failureMessage);
    return false;
   }
   return true;
  } catch (error) {
   setOptimistic(current => current === operation ? null : current);
   toast.error(failureMessage, {description: error instanceof Error ? error.message : undefined});
   return false;
  } finally {
   lock.current = false;
   setSaving(false);
   // Promise completion is not acknowledgement that React rendered the snapshot.
  }
 }
 return {displayed, moving: saving || !!optimistic, reorder};
}
