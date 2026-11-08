import {notFound} from 'next/navigation';
import Harness from './harness';

export const dynamic = 'force-dynamic';
/** Opt-in compatibility harness, no product UI or connection to Generate. */
export default function Page() {
  if (process.env.DUTY_SOLVER_SPIKE !== '1') notFound();
  return <Harness />;
}
