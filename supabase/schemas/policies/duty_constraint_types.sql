CREATE POLICY constraint_types_read ON public.duty_constraint_types FOR SELECT TO authenticated USING (true);
