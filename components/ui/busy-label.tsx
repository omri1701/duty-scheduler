import type {ReactNode} from 'react';

/** A button label that turns into its busy text in place (decision 2026-11-07: Generate shows its
 * progress on the button). Both texts share one grid cell, so the button keeps the wider one's
 * width and nothing moves when it switches; the hidden text is hidden from assistive tech too. */
export function BusyLabel({busy, idle, active}: {busy: boolean; idle: ReactNode; active: ReactNode}) {
  return <span className="busy-label" data-busy={busy || undefined}>
    <span aria-hidden={busy || undefined}>{idle}</span>
    <span aria-hidden={!busy || undefined}>{active}</span>
  </span>;
}
