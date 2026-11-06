import type {SupabaseClient} from '@supabase/supabase-js';
import type {schedulePayload} from './snapshot.ts';
import type {CompensationPublicationMetadata} from './compensation.ts';
import type {ManualOperation} from '../compensation/types.ts';
import type {AllocationDraft} from '../allocation/types.ts';
import type {GenerationInput, Approval} from '../scheduling/types.ts';
import type {PrimaryAssignments} from '../scheduling/validate.ts';
import type {NotificationSettings} from '../push/settings.ts';

type Revision = {p_revision: number};
type Operation<Args, Returns = null> = {Args: Args; Returns: Returns};
// The checked public RPC surface, mirrored from the existing migrations.
// JSON returned by duty_load is validated separately; this is not generated DB metadata.
export type Functions = {
  duty_load: Operation<Record<string, never>, unknown>;
  duty_balance: Operation<Record<string, never>, unknown>;
  duty_replanned_versions: Operation<{p_month: string}, unknown>;
  duty_generation_context: Operation<Revision & {p_month: string}, unknown>;
  duty_confirm_allocation: Operation<Revision & {p_month: string; p_allocation: AllocationDraft;
    p_locks: NonNullable<GenerationInput['locks']>; p_approvals: Approval[]; p_fingerprint: string}, unknown>;
  duty_save_generation: Operation<Revision & {p_month: string; p_assignments: PrimaryAssignments; p_fingerprint: string; p_seed: number}, unknown>;
  duty_join: Operation<{p_name: string}>;
  duty_add_temporary_member: Operation<Revision & {p_name: string}, string>;
  duty_rename_temporary_member: Operation<Revision & {p_member: string; p_name: string}>;
  duty_save_schedule: Operation<Revision & {p_state: ReturnType<typeof schedulePayload> & {compensation?: CompensationPublicationMetadata}; p_publish: string | null}>;
  duty_compensation: Operation<Revision & {p_operation: ManualOperation | {kind: 'reconcile'}; p_source_key: string | null; p_reason: string | null; p_fingerprint: string | null; p_cutoff: number | null}, unknown>;
  duty_set_constraints: Operation<Revision & {p_member: string; p_days: string[]; p_kind: string; p_note: string}>;
  duty_rename_self: Operation<Revision & {p_name: string}>;
  duty_set_role: Operation<Revision & {p_member: string; p_role: string}>;
  duty_set_no_weekends: Operation<Revision & {p_member: string; p_no_weekends: boolean}>;
  duty_restore_publication: Operation<Revision & {p_publication: string}>;
  duty_cancel_draft: Operation<Revision & {p_month: string}>;
  duty_delete_publication: Operation<Revision & {p_publication: string}>;
  duty_request_swap: Operation<Revision & {p_from: string; p_to: string; p_explanation: string}>;
  duty_swap_availability: Operation<{p_from: string; p_to: string}, unknown>;
  duty_resolve_swap: Operation<Revision & {p_request: string; p_action: 'accept' | 'decline' | 'approve' | 'reject' | 'cancel'; p_override_reason: string}, string>;
  duty_review_member: Operation<Revision & {p_member: string; p_status: 'approved' | 'rejected'}>;
  duty_calendar_status: Operation<Record<string, never>, unknown>;
  duty_calendar_reset: Operation<{p_language: 'en' | 'he'}, unknown>;
  duty_calendar_language: Operation<{p_language: 'en' | 'he'}>;
  // Personal settings and devices: no workspace revision (decision 2026-11-06).
  duty_set_language: Operation<{p_language: 'en' | 'he'}>;
  duty_notification_settings: Operation<Record<string, never>, unknown>;
  duty_set_notification_settings: Operation<{p_settings: NotificationSettings}, unknown>;
  duty_save_push_subscription: Operation<{p_endpoint: string; p_p256dh: string; p_auth: string}>;
  duty_delete_push_subscription: Operation<{p_endpoint: string}>;
  duty_send_test_notification: Operation<Record<string, never>, boolean>;
  duty_edit_published_duty: Operation<Revision & {p_publication: string; p_day: string; p_primary: string; p_extra_points: number;
    p_saturday_extra_points: number; p_kind: 'temporary' | 'permanent'; p_override_reason: string}, {publication: string; version: number}>;
};
export type Database = {public: {Tables: Record<string, never>; Views: Record<string, never>; Functions: Functions}};
export type DutyClient = SupabaseClient<Database>;
export type MutationName = Exclude<keyof Functions, 'duty_set_language' | 'duty_notification_settings' | 'duty_set_notification_settings' | 'duty_save_push_subscription' | 'duty_delete_push_subscription' | 'duty_send_test_notification' | 'duty_load' | 'duty_balance' | 'duty_replanned_versions' | 'duty_swap_availability' | 'duty_join' | 'duty_generation_context' | 'duty_confirm_allocation' | 'duty_save_generation' | 'duty_calendar_status' | 'duty_calendar_reset' | 'duty_calendar_language'>;
export type MutationArgs<N extends MutationName> = Omit<Functions[N]['Args'], 'p_revision'>;

export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message) return error.message;
  return fallback;
}
