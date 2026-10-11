CREATE POLICY month_statuses_read ON public.duty_month_statuses FOR SELECT TO authenticated USING (true);
