-- Cover both columns of the publication FK while supporting current-version lookups.
drop index public.duty_months_publication;
create index duty_months_publication on public.duty_months(current_publication_id,month);
