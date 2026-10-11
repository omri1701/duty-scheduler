CREATE POLICY workspace_read ON public.duty_workspace FOR SELECT TO authenticated USING (( SELECT duty_private.is_member() AS is_member));
