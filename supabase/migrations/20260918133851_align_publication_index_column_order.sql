-- Match the declared composite FK column order for the schema advisor.
drop index public.duty_months_publication;
create index duty_months_publication on public.duty_months(month,current_publication_id);
