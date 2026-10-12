-- Persistent synthetic upgrade fixtures: disposable LOCAL database only.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM auth.users) OR EXISTS (SELECT 1 FROM public.duty_members) THEN
    RAISE EXCEPTION 'Upgrade fixtures require an empty disposable database';
  END IF;
END $$;
BEGIN;
INSERT INTO auth.users(id,email) VALUES ('10000000-0000-0000-0000-000000000001','upgrade@example.invalid');
INSERT INTO public.duty_members(id,email,name,role,status,active)
VALUES ('10000000-0000-0000-0000-000000000001','upgrade@example.invalid','Upgrade fixture','admin','approved',true);
INSERT INTO public.duty_constraints(member_id,day,kind,note)
VALUES ('10000000-0000-0000-0000-000000000001','2099-01-15','no','Synthetic private note');
INSERT INTO public.duty_months(month,deadline,status,generated,publication_sequence)
VALUES ('2099-01','2098-12-20','published',true,1);
INSERT INTO public.duty_publications(id,month,published_by,version)
VALUES ('20000000-0000-0000-0000-000000000001','2099-01','10000000-0000-0000-0000-000000000001',1);
INSERT INTO public.duty_assignments(id,day,end_day,primary_id,publication_id,title,extra_points)
VALUES ('30000000-0000-0000-0000-000000000001','2099-01-12','2099-01-13',
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Synthetic history',2);
UPDATE public.duty_months SET current_publication_id='20000000-0000-0000-0000-000000000001' WHERE month='2099-01';
UPDATE public.duty_workspace SET revision=271 WHERE id;
COMMIT;
