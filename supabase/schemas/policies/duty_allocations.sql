CREATE POLICY allocations_read ON public.duty_allocations FOR SELECT TO authenticated
 USING ((SELECT duty_private.is_manager()));
