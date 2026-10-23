'use client';
import {useEffect} from 'react';
import {createSpikeWorker} from '../../lib/solver-spike/client.ts';

declare global {
  interface Window {solverSpike?: typeof createSpikeWorker}
}
export default function Harness() {
  useEffect(() => {
    window.solverSpike = createSpikeWorker;
    return () => {delete window.solverSpike;};
  }, []);
  return null;
}
