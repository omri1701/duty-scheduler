CREATE POLICY publications_read ON public.duty_publications FOR SELECT TO authenticated USING ((( SELECT duty_private.is_manager() AS is_manager) OR (( SELECT duty_private.is_member() AS is_member) AND (EXISTS ( SELECT 1
   FROM public.duty_months m
  WHERE (m.current_publication_id = duty_publications.id))))));
