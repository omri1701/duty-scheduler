// Synthetic LOCAL data shared by conversion and real CLI release rehearsals.
export const snapshot=`select jsonb_build_object(
 'months',(select jsonb_agg(to_jsonb(m) order by month) from public.duty_months m),
 'duties',(select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a),
 'publications',(select jsonb_agg(to_jsonb(p) order by id) from public.duty_publications p),
 'members',(select jsonb_agg(to_jsonb(m) order by id) from public.duty_members m),
 'notes',(select jsonb_agg(to_jsonb(c) order by member_id,day) from public.duty_constraints c),
 'requests',(select jsonb_agg(to_jsonb(r) order by id) from public.duty_swap_requests r),
 'revision',(select revision from public.duty_workspace where id))`;
export const manager='50000000-0000-0000-0000-000000000001',engineer='50000000-0000-0000-0000-000000000002';
export const seed=`do $$begin if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) then raise exception 'Requires an empty disposable database';end if;end$$;
insert into auth.users(id,email) values('${manager}','migration-manager@example.invalid'),('${engineer}','migration-engineer@example.invalid');
insert into public.duty_members(id,email,name,role,status,active) values('${manager}','migration-manager@example.invalid','Manager','admin','approved',true),('${engineer}','migration-engineer@example.invalid','Engineer','engineer','approved',true);
insert into public.duty_months(month,deadline,status,generated,publication_sequence) values
 ('2027-12','2027-11-24','published',true,2),('2028-01','2027-12-24','draft',true,1),('2028-02','2028-01-24','draft',false,0);
insert into public.duty_publications(month,version,published_by) values('2027-12',1,'${manager}'),('2027-12',2,'${manager}'),('2028-01',1,'${manager}');
insert into public.duty_assignments(publication_id,day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
select p.id,d::date,d::date+case when extract(dow from d)=5 and d<>'2027-12-31' then 2 else 1 end,
 '${manager}',case when d='2028-01-01' then '${engineer}'::uuid end,d='2028-01-01',case when d='2028-01-01' then 'Boundary special' else '' end,case when d='2028-01-01' then 2 else 0 end
from public.duty_publications p cross join generate_series('2027-12-01'::date,'2028-02-01'::date,interval '1 day') d
where (extract(dow from d)<>6 or d='2028-01-01') and (duty_private.duty_owner(d::date)=p.month or p.month='2028-01' and d='2028-01-01');
update public.duty_months m set current_publication_id=(select id from public.duty_publications p where p.month=m.month order by version desc limit 1) where publication_sequence>0;
insert into public.duty_assignments(day,end_day,primary_id,secondary_id,manager_override,title,extra_points)
select a.day,a.end_day,a.primary_id,a.secondary_id,a.manager_override,a.title,a.extra_points
from public.duty_assignments a join public.duty_months m on m.current_publication_id=a.publication_id where duty_private.duty_owner(a.day)=m.month;
update public.duty_assignments set title='Unpublished January special',extra_points=7,primary_id='${engineer}',manager_override=true where publication_id is null and day='2028-01-05';
insert into public.duty_assignments(day,end_day,primary_id,title,extra_points) values('2028-02-02','2028-02-03','${engineer}','Never published',4);
insert into public.duty_constraints(member_id,day,kind,note) values('${engineer}','2028-01-05','prefer','Private availability');
insert into public.duty_swap_requests(month,requester_id,other_id,from_day,from_end_day,to_day,to_end_day,status,accepted_by,accepted_at,resolved_by,resolved_at,result_publication_id)
select '2028-01','${manager}','${engineer}','2028-01-05','2028-01-06','2028-01-06','2028-01-07',status,
 case when status='approved' then '${engineer}'::uuid end,case when status='approved' then now() end,
 case when status='approved' then '${manager}'::uuid end,case when status='approved' then now() end,
 case when status='approved' then (select current_publication_id from public.duty_months where month='2028-01') end
from unnest(array['awaiting_engineer','approved']) status;
update public.duty_swap_requests r set
 source_publication_id=(select current_publication_id from public.duty_months where month=r.month),
 from_duty_id=(select a.id from public.duty_assignments a join public.duty_months m on m.current_publication_id=a.publication_id where m.month=r.month and a.day=r.from_day),
 to_duty_id=(select a.id from public.duty_assignments a join public.duty_months m on m.current_publication_id=a.publication_id where m.month=r.month and a.day=r.to_day);
update public.duty_workspace set revision=271 where id;
`;
