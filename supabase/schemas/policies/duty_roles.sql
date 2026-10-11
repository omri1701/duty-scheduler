CREATE POLICY roles_read ON public.duty_roles FOR SELECT TO authenticated USING (true);
