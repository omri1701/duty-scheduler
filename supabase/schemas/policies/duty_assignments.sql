CREATE POLICY assignments_read ON public.duty_assignments FOR SELECT TO authenticated USING ((( SELECT duty_private.is_manager() AS is_manager) OR (( SELECT duty_private.is_member() AS is_member) AND (publication_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.duty_months m
  WHERE (m.current_publication_id = duty_assignments.publication_id))))));
