import type {DutyClient} from './rpc.ts';

/** Ids of the month's versions a re-plan reversed: they can't be restored or brought back
 * by deleting the live version (decision 2026-11-01). Admin-only, read-only. */
export async function replannedVersions(client: DutyClient, month: string): Promise<string[]> {
  const {data, error} = await client.rpc('duty_replanned_versions', {p_month: month});
  if (error) throw error;
  if (!Array.isArray(data) || data.some(id => typeof id !== 'string')) throw Error('Invalid replanned versions');
  return data;
}
