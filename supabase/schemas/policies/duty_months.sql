CREATE POLICY months_read ON public.duty_months FOR SELECT TO authenticated USING (( SELECT duty_private.is_member() AS is_member));
