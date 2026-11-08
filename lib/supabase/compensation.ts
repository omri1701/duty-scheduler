import {project, replay} from '../compensation/index.ts';
import type {CompensationEvent, ManualOperation, Reservation, TransferIntent} from '../compensation/types.ts';
import type {DutyClient} from './rpc.ts';

/** Legacy reviewed metadata. Confirmed allocation months compile it on the server. */
export type CompensationPublicationMetadata = {
  fingerprint: string;
  reservations: readonly Reservation[];
  intents: readonly TransferIntent[];
};
export type CompensationRequest = {
  operation: ManualOperation | {kind: 'reconcile'};
  revision: number;
  sourceKey?: string;
  reason?: string;
  fingerprint?: string;
  cutoffMs?: number;
};

/** The server owns validation/time/authority. PR #33 owns the client read model. */
export async function compensation(client: DutyClient, request: CompensationRequest) {
  const {data, error} = await client.rpc('duty_compensation', {
    p_operation: request.operation,
    p_revision: request.revision,
    p_source_key: request.sourceKey ?? null,
    p_reason: request.reason ?? null,
    p_fingerprint: request.fingerprint ?? null,
    p_cutoff: request.cutoffMs ?? null,
  });
  if (error) throw error;
  if (!data || typeof data !== 'object' || !('actual' in data) || !('revision' in data) ||
    !('actualAtMs' in data) || !('fingerprint' in data)) throw new Error('Invalid compensation response');
  const response = data as {actual: {events: CompensationEvent[]}; revision: number; actualAtMs: number; fingerprint: string};
  const actual = replay(response.actual.events);
  return {revision: response.revision, fingerprint: response.fingerprint, actualAtMs: response.actualAtMs, actual,
    projected: request.cutoffMs === undefined ? null : project(actual.events, response.actualAtMs, request.cutoffMs).projected};
}
