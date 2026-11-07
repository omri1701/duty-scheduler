-- Own rows only, for every member including admins.
CREATE POLICY notification_settings_read ON public.duty_notification_settings FOR SELECT TO authenticated USING ((member_id = ( SELECT duty_private.current_member_id() AS current_member_id)));
CREATE POLICY push_subscriptions_read ON public.duty_push_subscriptions FOR SELECT TO authenticated USING ((member_id = ( SELECT duty_private.current_member_id() AS current_member_id)));
CREATE POLICY push_notifications_read ON public.duty_push_notifications FOR SELECT TO authenticated USING ((member_id = ( SELECT duty_private.current_member_id() AS current_member_id)));
CREATE POLICY push_deliveries_read ON public.duty_push_deliveries FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.duty_push_notifications n
  WHERE ((n.id = duty_push_deliveries.notification_id) AND (n.member_id = ( SELECT duty_private.current_member_id() AS current_member_id))))));
