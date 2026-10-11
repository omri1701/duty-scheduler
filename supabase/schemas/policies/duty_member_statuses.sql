CREATE POLICY member_statuses_read ON public.duty_member_statuses FOR SELECT TO authenticated USING (true);
