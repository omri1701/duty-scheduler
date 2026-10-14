'use client';
import {useSyncExternalStore} from 'react';

const query = '(max-width: 600px)';
function subscribe(onChange: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

// Match the phone CSS breakpoint; leave tablet and desktop rendering intact.
export function useMobileLayout() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
