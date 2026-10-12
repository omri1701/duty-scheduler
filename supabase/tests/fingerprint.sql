-- Schema-only fingerprints for comparing a clean local installation with a hosted target.
-- No user data, credentials or Supabase-managed definitions are included.
SET search_path = '';
WITH tables AS (
  SELECT c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relowner
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'duty_%'
), functions AS (
  SELECT p.oid,n.nspname,p.proname,p.proowner,pg_catalog.pg_get_functiondef(p.oid) definition
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='duty_private' OR (n.nspname='public' AND p.proname LIKE 'duty_%')
), objects AS (
  SELECT 'tables' category,t.relname name,
    pg_catalog.jsonb_build_object('rls',t.relrowsecurity,'forced',t.relforcerowsecurity,
      'owner',pg_catalog.pg_get_userbyid(t.relowner),
      'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
        'generated',a.attgenerated,'identity',a.attidentity,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),
      'privileges',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',r,'privilege',p,
        'allowed',pg_catalog.has_table_privilege(r,t.oid,p)) ORDER BY r,p)
        FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) r
        CROSS JOIN pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p)) definition
  FROM tables t
  UNION ALL
  SELECT 'constraints',c.conname,pg_catalog.to_jsonb(pg_catalog.pg_get_constraintdef(c.oid,true))
  FROM pg_catalog.pg_constraint c JOIN tables t ON t.oid=c.conrelid
  UNION ALL
  SELECT 'indexes',c.relname,pg_catalog.to_jsonb(pg_catalog.pg_get_indexdef(i.indexrelid))
  FROM pg_catalog.pg_index i JOIN tables t ON t.oid=i.indrelid JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
  UNION ALL
  SELECT 'triggers',g.tgname,pg_catalog.to_jsonb(pg_catalog.pg_get_triggerdef(g.oid,true))
  FROM pg_catalog.pg_trigger g JOIN tables t ON t.oid=g.tgrelid WHERE NOT g.tgisinternal
  UNION ALL
  SELECT 'policies',p.polname,pg_catalog.jsonb_build_object('table',t.relname,'command',p.polcmd,
    'permissive',p.polpermissive,'roles',(SELECT pg_catalog.jsonb_agg(r.rolname ORDER BY r.rolname)
      FROM pg_catalog.pg_roles r WHERE r.oid=ANY(p.polroles)),
    'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))
  FROM pg_catalog.pg_policy p JOIN tables t ON t.oid=p.polrelid
  UNION ALL
  SELECT 'functions',f.nspname||'.'||f.proname,pg_catalog.jsonb_build_object('sql',f.definition,
    'owner',pg_catalog.pg_get_userbyid(f.proowner),
    'privileges',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',r,
      'execute',pg_catalog.has_function_privilege(r,f.oid,'EXECUTE')) ORDER BY r)
      FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) r))
  FROM functions f
  UNION ALL
  SELECT 'schemas',n.nspname,pg_catalog.jsonb_build_object('owner',pg_catalog.pg_get_userbyid(n.nspowner),
    'privileges',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',r,'privilege',p,
      'allowed',pg_catalog.has_schema_privilege(r,n.oid,p)) ORDER BY r,p)
      FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) r
      CROSS JOIN pg_catalog.unnest(ARRAY['USAGE','CREATE']) p))
  FROM pg_catalog.pg_namespace n WHERE n.nspname='duty_private'
)
SELECT category,count(*) objects,pg_catalog.md5(pg_catalog.jsonb_agg(
  pg_catalog.jsonb_build_object('name',name,'definition',definition) ORDER BY name)::text) fingerprint
FROM objects GROUP BY category ORDER BY category;
RESET search_path;
