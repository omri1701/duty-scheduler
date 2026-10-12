ALTER TABLE ONLY public.duty_months
    ADD CONSTRAINT duty_months_month_current_publication_id_fkey FOREIGN KEY (month, current_publication_id) REFERENCES public.duty_publications(month, id);
