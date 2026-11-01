// Action-sequence "monkey" through the checked RPCs (decision 2026-11-01): a seed team over
// four consecutive months, random actions in random order, only where the UI would allow
// them. Every action must succeed; a refusal the UI did not prevent is a finding. After
// every action the ledger replays exactly, balances, and has no live chain. LOCAL-only, each action
// its own transaction; the disposable database is reset at the end.
// node supabase/tests/monkey.mjs supabase_db_<project> [steps] [seed]
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import loadHighs from 'highs';
import {createHighsAdapter, createGenerationRequest, solveGeneration} from '../../lib/scheduling/index.ts';
import {readGenerationContext} from '../../lib/supabase/generation.ts';
import {proposeAllocation, editAllocation, transferAllocation, planAllocation, persistedDraft, balanced} from '../../lib/allocation/index.ts';
import {allocationTotals, reopenAllocation} from '../../lib/allocation/review.ts';
import {replay} from '../../lib/compensation/index.ts';
import {userMessage} from '../../lib/messages.ts';
import {eligibleSwapTarget, swapProblem} from '../../lib/supabase/swaps.ts';

const container = process.argv[2]; assert.match(container ?? '', /^supabase_db_[\w-]+$/);
const STEPS = Number(process.argv[3] ?? process.env.MONKEY_STEPS ?? 40), SEED = Number(process.argv[4] ?? process.env.MONKEY_SEED ?? 20261101);
const MONTHS = ['2027-12', '2028-01', '2028-02', '2028-03'];
const ids = Array.from({length: 10}, (_, i) => `74000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`), manager = ids[0];
let state = SEED >>> 0;
const random = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32;
const pick = xs => xs[Math.floor(random() * xs.length)];
const quote = v => "'" + JSON.stringify(v).replaceAll("'", "''") + "'::jsonb";
const rev = '(select revision from public.duty_workspace where id)';
const solver = await createHighsAdapter(loadHighs);
const generic = userMessage('some-internal-code', en => en);

const claims = as => `set local request.jwt.claim.sub='${as}';set local request.jwt.claims='{"sub":"${as}","role":"authenticated"}';set local role authenticated;`;
/** One statement in its own transaction as that member (postgres when null): committed when it succeeds, rolled back when refused. */
function run(sql, as = manager) {
  const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    {input: `begin;${as ? claims(as) : ''}
${sql}
commit;`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  const error = r.stderr.split(/\r?\n/).find(l => l.startsWith('ERROR:'))?.replace(/^ERROR:\s+/, '').trim();
  return {rows: r.stdout.split(/\r?\n/).filter(l => l.startsWith('{') || l.startsWith('[')).map(l => JSON.parse(l)), error};
}
const rpc = sql => run(sql);
function asPostgres(sql) {
  const r = run(sql, null);
  if (r.error) throw Error(`monkey: ${r.error}`);
  return r.rows;
}

asPostgres(`
do $$begin if exists(select 1 from public.duty_members) or exists(select 1 from public.duty_compensation_events) then raise exception 'Requires empty disposable LOCAL';end if;end$$;
create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select ${Date.parse('2027-10-15T00:00:00Z')}::bigint$$;
insert into auth.users(id,email) values ${ids.map((id, i) => `('${id}','monkey-${i}@example.invalid')`).join(',')};
insert into public.duty_members(id,email,name,role,status,active,seniority) values ${ids.map((id, i) => `('${id}','monkey-${i}@example.invalid','Monkey ${i}','${i ? 'engineer' : 'admin'}','approved',true,${i + 1})`).join(',')};
insert into public.duty_months(month,deadline) values ${MONTHS.map(m => `('${m}','${m.slice(0, 5)}${String(Number(m.slice(5)) - 1 || 12).padStart(2, '0')}-20')`).join(',').replace('2028-12-20', '2027-12-20')};`);

const findings = [], counts = {};
const count = key => {counts[key] = (counts[key] ?? 0) + 1;};
const months = () => Object.fromEntries(({rows: asPostgres(`select json_object_agg(month,json_build_object('status',status,'generated',generated,'publication',current_publication_id,'deadline',deadline)) from public.duty_months;`)}).rows[0] ? Object.entries(({rows: asPostgres(`select json_object_agg(month,json_build_object('status',status,'generated',generated,'publication',current_publication_id,'deadline',deadline)) from public.duty_months;`)}).rows[0]) : []);
function context(month) {
  const r = rpc(`select public.duty_generation_context('${month}',${rev});`);
  if (r.error) {findings.push({action: 'context', month, error: r.error}); return null;}
  return {raw: r.rows[0], ...readGenerationContext(r.rows[0])};
}
/** The month's draft duties as the calendar holds them, and the save payload around them. */
const draftDuties = month => asPostgres(`select coalesce(jsonb_agg(to_jsonb(a) order by day),'[]') from public.duty_assignments a where publication_id is null and duty_private.duty_owner(day)='${month}';`)[0];
const nextDay = day => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
// The duty editor reviews the lock of every duty it saves (lock_edits), as schedulePayload sends it.
const schedule = (month, m, duties, edited = []) => ({...(edited.length ? {lock_edits: edited} : {}), team: [], months: {[month]: {status: 'draft', deadline: m.deadline, generated: true}}, duties});
function edits(i, d, n) {
  for (let k = 0; k < n; k++) {
    const x = pick(i.seniority), kind = random() < 0.7 ? 'temporary' : 'permanent';
    try {
      if (random() < 0.3) for (const id of i.seniority) {if (id !== x && d.targetsUnits[id]) d = transferAllocation(i, d, {id: `m${serial}-${k}-${id}`, fromId: id, toId: x, units: d.targetsUnits[id], kind}).draft;}
      else d = editAllocation(i, d, {engineer: x, deltaUnits: pick([-2, -2, 2, 2, -4, 4]), kind}).draft;
    } catch {/* refused before the click: the control is disabled */}
  }
  return d;
}
function checkLedger(where) {
  const [view] = asPostgres(`select duty_private.compensation_view(duty_private.compensation_state());`);
  const ordered = v => {v = structuredClone(v); for (const k of ['members', 'lots', 'contributions', 'settlements', 'publications']) v[k]?.sort((a, b) => a.id.localeCompare(b.id)); return v;};
  assert.deepEqual(ordered(view), ordered(replay(view.events)), `${where}: the ledger replays exactly`);
  assert.equal(Object.values(view.net).reduce((a, b) => a + b, 0), 0, `${where}: balances`);
  const live = view.claims.filter(k => !k.frozen);
  assert.ok(!live.some(k => live.some(o => k.creditorId === o.debtorId)), `${where}: no live chain`);
}
function act(action, month, sql, as = manager) {
  const r = run(sql, as);
  if (r.error) {
    findings.push({action, month, error: r.error, message: userMessage(r.error, en => en)});
    count(`refused ${action}`);
  } else count(action);
  return r;
}

for (let step = 0; step < STEPS; step++) {
  const state = months(), month = pick(MONTHS), m = state[month], where = `step ${step} ${month}`;
  const action = pick(['plan', 'plan', 'generate', 'generate', 'publish', 'publish', 'reopen', 'cancel', 'move', 'constraint', 'deadline', 'delete-version', 'restore-version', 'lock', 'swap']);
  if (action === 'plan' || action === 'generate') {
    if (m.status !== 'draft') {count('skip: published'); continue;}
    const c = context(month); if (!c || !c.generationAllowed) continue;
    // Plan the month, then (for Generate) Confirm & generate: the app confirms the reviewed plan first.
    let d = c.allocation ? reopenAllocation(c.input, c.allocation) : proposeAllocation(c.input).draft;
    if (action === 'plan') d = edits(c.input, d, Math.floor(random() * 4));
    if (!balanced(d) || !planAllocation(c.input, d).confirmable) {count('prevented: unbookable plan'); d = proposeAllocation(c.input).draft;}
    const confirmed = act('confirm', month, `select public.duty_confirm_allocation('${month}',${quote(persistedDraft(d))},${quote(c.input.schedule.locks ?? [])},${quote(c.input.schedule.approvals ?? [])},${rev},'${c.raw.fingerprint}');`);
    if (action === 'generate' && !confirmed.error) {
      const g = readGenerationContext(confirmed.rows[0]);
      const result = solveGeneration(solver, createGenerationRequest(g.generationInput, {now: g.actualAtMs, seed: step + 1, seconds: 5}));
      act('generate', month, `select public.duty_save_generation('${month}',${quote(result.assignments)},${rev},'${confirmed.rows[0].fingerprint}',${step + 1});`);
    }
  } else if (action === 'publish') {
    if (m.status !== 'draft' || !m.generated) {count('skip: not generated'); continue;}
    const [{holes}] = ({rows: asPostgres(`select json_build_object('holes',count(*)) from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)='${month}' and primary_id is null;`)}).rows;
    if (holes) {count('prevented: holes'); continue;}
    // Publish is disabled while an assignment conflicts with availability (workspaceMetrics conflicts).
    const [{conflicts}] = asPostgres(`select json_build_object('conflicts',count(*)) from public.duty_assignments a join public.duty_constraints c on c.member_id in (a.primary_id,a.secondary_id) and c.kind='no' and c.day>=a.day and c.day<a.end_day where a.publication_id is null and duty_private.duty_owner(a.day)='${month}' and not a.manager_override;`);
    if (conflicts) {count('prevented: availability conflicts'); continue;}
    // Publish waits while anyone's scheduled points differ from the saved plan (the workspace's note).
    const c = context(month);
    if (c?.allocation && allocationTotals(c.input, c.allocation, c.assignments).rows.some(r => r.assigned !== r.target)) {count('prevented: plan differs'); continue;}
    act('publish', month, `select public.duty_save_schedule(${quote(schedule(month, m, draftDuties(month)))},${rev},'${month}');`);
  } else if (action === 'reopen') {
    if (m.status !== 'published') {count('skip: draft'); continue;}
    act('reopen', month, `select public.duty_restore_publication('${m.publication}',${rev});`);
  } else if (action === 'cancel') {
    if (m.status !== 'draft' || !m.publication) {count('skip: no reopened draft'); continue;}
    act('cancel', month, `select public.duty_cancel_draft('${month}',${rev});`);
  } else if (action === 'move') {
    if (m.status !== 'draft' || !m.generated) {count('skip: no draft'); continue;}
    // Swap the primaries of two weekday duties in the draft, editing each in the duty editor.
    const duties = draftDuties(month), days = duties.filter(d => d.end_day === nextDay(d.day));
    if (days.length < 2) {count('skip: no duties'); continue;}
    const [x, y] = [pick(days), pick(days)];
    [x.primary_id, y.primary_id] = [y.primary_id, x.primary_id];
    act('move', month, `select public.duty_save_schedule(${quote(schedule(month, m, duties, [x.day, y.day]))},${rev});`);
  } else if (action === 'constraint') {
    const day = `${month}-${String(2 + Math.floor(random() * 26)).padStart(2, '0')}`;
    act('constraint', month, `select public.duty_set_constraints('${pick(ids.slice(1))}',array['${day}'::date],'no','Monkey',${rev});`);
  } else if (action === 'deadline') {
    act('deadline', month, `select public.duty_save_schedule(jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object('${month}',jsonb_build_object('status','${m.status}','deadline','${month.slice(0, 5)}0${1 + Math.floor(random() * 8)}-1${Math.floor(random() * 9)}'.replace(/^(\\d{4})-0(\\d)/,'$1-0$2'),'generated',${m.generated}))),${rev});`.replace(/'(\d{4})-0(\d)-1(\d)'/, (_, y, mo, d) => `'${month.slice(0, 4)}-${month.slice(5)}-0${d || 1}'`));
  } else if (action === 'delete-version' || action === 'restore-version') {
    // Versions disables what a re-plan reversed: restoring such a version, or deleting the
    // live one when the newest other version is such a version.
    const versions = asPostgres(`select json_agg(id order by version desc) from public.duty_publications where month='${month}';`)[0] ?? [];
    if (!versions.length) {count('skip: no versions'); continue;}
    const v = pick(versions), replacement = versions.find(id => id !== v), blocked = rpc(`select public.duty_replanned_versions('${month}');`).rows[0] ?? [];
    if (action === 'restore-version' ? blocked.includes(v) : v === m.publication && blocked.includes(replacement)) {count('prevented: re-planned version'); continue;}
    act(action, month, action === 'restore-version' ? `select public.duty_restore_publication('${v}',${rev});` : `select public.duty_delete_publication('${v}',${rev});`);
  } else if (action === 'lock') {
    // Lock or unlock a draft duty in the duty editor.
    if (m.status !== 'draft' || !m.generated) {count('skip: no draft'); continue;}
    const duties = draftDuties(month), staffed = duties.filter(d => d.primary_id);
    if (!staffed.length) {count('skip: no duties'); continue;}
    const d = pick(staffed); d.locked = !d.locked;
    act(d.locked ? 'lock' : 'unlock', month, `select public.duty_save_schedule(${quote(schedule(month, m, duties, [d.day]))},${rev});`);
  } else if (action === 'swap') {
    // An engineer asks to swap a published duty with someone else's, as Swaps offers it; the
    // other engineer accepts and the admin approves. Each step is skipped where Swaps prevents
    // it (swapProblem, with the availability that person may read).
    if (m.status !== 'published') {count('skip: not published'); continue;}
    const rows = asPostgres(`select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('owner',duty_private.duty_owner(day)) order by day),'[]') from public.duty_assignments a where publication_id='${m.publication}';`)[0];
    const raw = {assignments: rows, constraints: asPostgres(`select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.duty_constraints c;`)[0]};
    const duties = rows.filter(a => a.primary_id && a.owner === month);
    const source = pick(duties), targets = duties.filter(t => eligibleSwapTarget(source, t));
    if (!source || !targets.length) {count('skip: no swap target'); continue;}
    const target = pick(targets), own = {...raw, constraints: raw.constraints.filter(c => c.member_id === source.primary_id)};
    if (swapProblem(own, month, source, target)) {count('prevented: swap request'); continue;}
    const requested = run(`select public.duty_request_swap('${source.id}','${target.id}','Monkey',${rev});`, source.primary_id);
    // Known gap: the counterpart's availability is private, so Swaps can't check it before the click.
    if (requested.error && /Availability conflict/.test(requested.error) && swapProblem(raw, month, source, target)?.kind === 'availability') {count('refused swap request: counterpart unavailable (private)'); checkLedger(where); continue;}
    if (requested.error) {findings.push({action: 'swap-request', month, error: requested.error, message: userMessage(requested.error, en => en)}); checkLedger(where); continue;}
    count('swap-request');
    if (swapProblem(raw, month, source, target, false)) {count('prevented: swap accept'); continue;}
    const request = `(select id from public.duty_swap_requests where from_duty_id='${source.id}' and status='awaiting_engineer' order by created_at desc limit 1)`;
    if (act('swap-accept', month, `select public.duty_resolve_swap(${request},'accept',${rev});`, target.primary_id).error) {checkLedger(where); continue;}
    const problem = swapProblem(raw, month, source, target);
    if (problem?.kind === 'weekend') {count('prevented: swap approve'); continue;}
    act('swap-approve', month, `select public.duty_resolve_swap((select id from public.duty_swap_requests where from_duty_id='${source.id}' and status='awaiting_admin' order by created_at desc limit 1),'approve',${rev},'${problem ? 'Monkey override' : ''}');`);
  }
  checkLedger(where);
}
// Leave the disposable database empty for the suites after this one.
spawnSync('pnpm', ['dlx', 'supabase@2.119.0', 'db', 'reset', '--local'], {stdio: 'ignore', shell: true});
console.log(JSON.stringify(counts));
const named = findings.filter(f => f.message !== generic);
for (const f of findings) console.log(`FINDING ${f.action} ${f.month}: ${f.error}${f.message && f.message !== f.error ? ` → ${f.message}` : ''}`);
assert.equal(findings.length - named.length, 0, 'no refusal reaches the user as a generic message');
assert.deepEqual(findings, [], 'every action the UI allows succeeds');
console.log(`PASS: ${STEPS} random actions over ${MONTHS.length} months through the checked RPCs; every one succeeded and the ledger stayed consistent`);
