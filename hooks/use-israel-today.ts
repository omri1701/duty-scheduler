'use client';
import {useSyncExternalStore} from 'react';
import {todayIsrael, millisecondsUntilIsraelMidnight} from '@/lib/rota/calendar-dates';

const serverDay = () => '';
function subscribe(notify: () => void) {
  let day = todayIsrael();
  let timer: ReturnType<typeof setTimeout>;
  const refresh = () => {
    const next = todayIsrael();
    if (next !== day) {day = next; notify();}
    clearTimeout(timer);
    timer = setTimeout(refresh, millisecondsUntilIsraelMidnight(new Date()) + 25);
  };
  const visible = () => {if (document.visibilityState === 'visible') refresh()};
  refresh();
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', visible);
  return () => {
    clearTimeout(timer);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('pageshow', refresh);
    document.removeEventListener('visibilitychange', visible);
  };
}

// One calendar subscription. Resume checks notify React only when the date changes.
export function useIsraelToday() {return useSyncExternalStore(subscribe, todayIsrael, serverDay)}
