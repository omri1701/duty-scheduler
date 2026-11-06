-- A member reads only their own feed row (never anyone else's). The raw token is never stored.
CREATE POLICY calendar_feeds_read ON public.duty_calendar_feeds FOR SELECT TO authenticated USING ((member_id = ( SELECT auth.uid() AS uid)));
