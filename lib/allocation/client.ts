/** Add only whole elapsed milliseconds to the integer server timestamp.
 * Rounding at epoch magnitude can otherwise close the window just before cutoff. */
export function generationNow(serverMs: number, receivedMonotonicMs: number, monotonicMs: number) {
  return serverMs + Math.floor(monotonicMs - receivedMonotonicMs);
}

export function schedulingSupported() {
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function';
}
