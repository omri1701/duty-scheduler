-- Event notifications, recorded in the same transaction as the change (a rolled-back
-- change notifies nobody). Event alerts are sent at commit (push_dispatch_now);
-- deadlines and reminders by the clock (push_tick).
CREATE TRIGGER duty_push_month_events AFTER UPDATE OF status, current_publication_id ON public.duty_months FOR EACH ROW WHEN (((old.current_publication_id IS DISTINCT FROM new.current_publication_id) AND (new.current_publication_id IS NOT NULL))) EXECUTE FUNCTION duty_private.push_month_events();
CREATE TRIGGER duty_push_swap_events AFTER INSERT OR UPDATE OF status, other_id, accepted_by, requester_accepted_at ON public.duty_swap_requests FOR EACH ROW EXECUTE FUNCTION duty_private.push_swap_events();
CREATE TRIGGER duty_push_member_events AFTER INSERT ON public.duty_members FOR EACH ROW WHEN ((new.status = 'pending'::text)) EXECUTE FUNCTION duty_private.push_member_events();
CREATE CONSTRAINT TRIGGER duty_push_dispatch_now AFTER INSERT ON public.duty_push_notifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.kind <> ALL (ARRAY['deadline_3'::text, 'deadline_1'::text, 'remind_evening'::text, 'remind_morning'::text]))) EXECUTE FUNCTION duty_private.push_dispatch_now();
