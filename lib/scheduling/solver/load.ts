import {createHighsAdapter} from './highs-adapter.ts';
import type loadHighs from 'highs';

/** Same-origin, lockfile-pinned assets; no CDN or cross-origin isolation required. */
export async function loadSchedulingAdapter() {
  const asset = (name: string) => new URL(`/api/scheduling/asset/${name}`, self.location.origin).href;
  const {default: load} = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ asset('highs.mjs')) as {default: typeof loadHighs};
  return createHighsAdapter(load, {locateFile: () => asset('highs.wasm')});
}
