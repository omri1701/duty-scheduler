import type {SupabaseClient} from '@supabase/supabase-js';
import type {schedulePayload} from './snapshot.ts';
import type {CompensationPublicationMetadata} from './compensation.ts';
import type {ManualOperation} from '../compensation/types.ts';

type Revision = {p_revision: number};
type Operation<Args, Returns = null> = {Args: Args; Returns: Returns};
// The checked public RPC surface, mirrored from the existing migrations.
// JSON returned by duty_load is validated separately; this is not generated DB metadata.
export type Functions = {
  duty_load: Operation<Record<string, never>, unknown>;
  duty_join: Operation<{p_name: string}>;
  duty_save_schedule: Operation<Revision & {p_state: ReturnType<typeof schedulePayload> & {compensation?: CompensationPublicationMetadata}; p_publish: string | null}>;
  duty_compensation: Operation<Revision & {p_operation: ManualOperation | {kind: 'reconcile'}; p_source_key: string | null; p_reason: string | null; p_fingerprint: string | null; p_cutoff: number | null}, unknown>;
  duty_set_constraints: Operation<Revision & {p_member: string; p_days: string[]; p_kind: string; p_note: string}>;
  duty_rename_self: Operation<Revision & {p_name: string}>;
  duty_set_role: Operation<Revision & {p_member: string; p_role: string}>;
  duty_restore_publication: Operation<Revision & {p_publication: string}>;
  duty_cancel_draft: Operation<Revision & {p_month: string}>;
  duty_delete_publication: Operation<Revision & {p_publication: string}>;
  duty_request_swap: Operation<Revision & {p_from: string; p_to: string; p_explanation: string}>;
  duty_resolve_swap: Operation<Revision & {p_request: string; p_action: 'accept' | 'decline' | 'approve' | 'reject' | 'cancel'; p_override_reason: string}, string>;
  duty_review_member: Operation<Revision & {p_member: string; p_status: 'approved' | 'rejected'}>;
};
export type Database = {public: {Tables: Record<string, never>; Views: Record<string, never>; Functions: Functions}};
export type DutyClient = SupabaseClient<Database>;
export type MutationName = Exclude<keyof Functions, 'duty_load' | 'duty_join'>;
export type MutationArgs<N extends MutationName> = Omit<Functions[N]['Args'], 'p_revision'>;

export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message) return error.message;
  return fallback;
}
