import type {ReactNode} from 'react';

/** A button label that turns into its busy text in place (decision 2026-11-07: Generate shows its
 * progress on the button). Both texts share one grid cell, so the button keeps the wider one's
 * width and nothing moves when it switches; the hidden text is hidden from assistive tech too.
 * short: on PC the button keeps its resting width and shows this shorter busy text (ellipsized
 * if it still doesn't fit); phones keep the full text, which sizes the button. Give the button an
 * aria-label while busy, since the accessible name follows the visible text. */
export function BusyLabel({busy, idle, active, short}: {busy: boolean; idle: ReactNode; active: ReactNode; short?: ReactNode}) {
  return <span className="busy-label" data-busy={busy || undefined} data-fit={short ? '' : undefined}>
    <span aria-hidden={busy || undefined}>{idle}</span>
    <span aria-hidden={!busy || undefined}>{short ? <><span className="busy-long">{active}</span><span className="busy-short">{short}</span></> : active}</span>
  </span>;
}
