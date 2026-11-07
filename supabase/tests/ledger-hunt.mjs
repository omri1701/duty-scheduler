// Generator-based ledger hunt (decision 2026-11-06). Random sequences over two months of
// publish, swap (equal, weighted, split weekend), published edit Temporary/Permanent (on
// swapped and repayment duties too, with extra points), re-edit, exact undo, reopen +
// republish, delete live version and re-plan, through the real RPCs. After every step:
//  (a) the ledger equals an independent model whose only causes are Temporary replacements
//      (an edit or each side of a swap: the replaced holder owes the new one) and planned
//      repayments; (b) Permanent never creates a debt (giving a duty back to whoever held it
//      before a Temporary change still in effect undoes that change, H1); (c) an exact undo (the inverse edit or
//      swap, or deleting the live version) restores the balances before it; (d) Plan the
//      month / Reset of either month starts from the other month's entries only; (e) the
//      SQL ledger replays exactly in the TypeScript core; (f) per person, points done minus
//      their balance equals planned points (less repayments that happen) + permanent in − out.
// A failure is shrunk to a minimal sequence and printed.
// Balances are "booked + planned": lots plus every live repayment as if worked.
// The shrunk sequences of the bugs it found replay first, then the random seeds.
// Usage: node supabase/tests/ledger-hunt.mjs <container> [seeds=12] [steps=10] [first seed=1]
// (LEDGER_HUNT_VERBOSE=1 prints every sequence; LEDGER_HUNT_SKIP_REGRESSIONS=1 skips the fixed ones.)
// Only synthetic fixtures in an empty disposable LOCAL container; every sequence rolls back.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {canonicalDuties} from '../../lib/scheduling/calendar.ts';
import {replay} from '../../lib/compensation/index.ts';
import {deriveTransfers} from '../../lib/allocation/derive.ts';
import {fitPartition} from '../../lib/allocation/fit.ts';

const container = process.argv[2];
assert.match(container ?? '', /^supabase_db_[\w-]+$/);
const seeds = Number(process.argv[3] ?? 12), steps = Number(process.argv[4] ?? 10), firstSeed = Number(process.argv[5] ?? 1);
const ids = Array.from({length: 13}, (_, i) => `75000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`);
const manager = ids[0], M1 = '2027-12', M2 = '2028-01', SPLIT = '2027-12-10';
const short = id => 'm' + Number(id.slice(-2));
const quote = v => "'" + JSON.stringify(v).replaceAll("'", "''") + "'::jsonb";
const rev = '(select revision from public.duty_workspace where id)';
const current = m => `(select current_publication_id from public.duty_months where month='${m}')`;
const nextOf = m => m === M1 ? M2 : '2028-02';

// ---- Fixture plans: constructive placements with an explicit ordinary baseline. ----
const calendar = {[M1]: {splitWeekends: [SPLIT]}, [M2]: {}};
/** The month's duties at their current points: an edit's extra stays through re-plans. */
const dutyList = (m, extra = {}) => canonicalDuties(m, calendar[m]).map(d => ({...d, units: d.units + 2 * (extra[d.id] ?? 0)}));
function firstPlacement() {
  let weekend = 0, weekday = 0;
  return Object.fromEntries(dutyList(M1).map(d => [d.id, {primary: ids[d.weekendId ? weekend++ : 6 + weekday++ % 7]}]));
}
/** Planning weights: a split weekend counts as the weekend it came from (decision 2026-11-07). */
const planWeights = list => [...list.reduce((w, d) => w.set(d.weekendId ?? d.id, (w.get(d.weekendId ?? d.id) ?? 0) + d.units), new Map()).values()];
/** The ordinary baseline: the cheapest exact partition, larger shares to the first members. */
const fairOf = (m, extra) => {const shares = fitPartition(planWeights(dutyList(m, extra)), ids.length).sort((a, b) => b - a);
  return Object.fromEntries(ids.map((id, i) => [id, shares[i]]));};
function draftFor(m, placed, key, repay, extra) {
  const list = dutyList(m, extra), fair = fairOf(m, extra);
  const offered = {...fair};
  if (repay) {offered[repay.debtorId] += 2; offered[repay.creditorId] -= 2;}
  const totals = Object.fromEntries(ids.map(id => [id, 0]));
  for (const d of list) totals[placed[d.id].primary] += d.units;
  const now = {...offered}, transfers = [];
  for (const fromId of ids) for (const toId of ids) {
    const n = Math.min(now[fromId] - totals[fromId], totals[toId] - now[toId]);
    if (n > 0) {transfers.push({id: 'baseline/' + transfers.length, fromId, toId, units: n, kind: 'permanent'}); now[fromId] -= n; now[toId] += n;}
  }
  const changes = Object.fromEntries(ids.map(id => [id, {temporary: 0, permanent: 0}]));
  for (const t of transfers) {changes[t.fromId][t.kind] -= t.units; changes[t.toId][t.kind] += t.units;}
  return {baselineUnits: fair, offeredUnits: offered, targetsUnits: totals, repayments: [], changes, pairs: transfers,
    transfers: deriveTransfers(ids, changes, transfers), sourceKey: key};
}
/** January: weekday-only members repay first; the debtor takes two more units. */
function nextPlacement(repay, extra) {
  const list = dutyList(M2, extra), base = fairOf(M2, extra);
  if (repay) {base[repay.debtorId] += 2; base[repay.creditorId] -= 2;}
  const remaining = {...base}, chosen = {}, seen = new Map(ids.map(id => [id, new Set()]));
  const place = i => {
    if (i === list.length) return Object.values(remaining).every(n => n === 0);
    const d = list[i];
    for (const id of [...ids].sort((p, q) => remaining[q] - remaining[p] || p.localeCompare(q))) {
      if (remaining[id] < d.units || (i && chosen[list[i - 1].id]?.primary === id) || (d.weekendId && seen.get(id).size && !seen.get(id).has(d.weekendId))) continue;
      // December's last weekend ends on January 2; its engineer doesn't start January.
      if (i === 0 && id === firstPlacement()['2027-12-31'].primary) continue;
      remaining[id] -= d.units; chosen[d.id] = {primary: id}; if (d.weekendId) seen.get(id).add(d.weekendId);
      if (place(i + 1)) return true;
      if (d.weekendId) seen.get(id).delete(d.weekendId); remaining[id] += d.units;
    }
    return false;
  };
  assert.ok(place(0), 'constructive January fixture');
  return chosen;
}
const publishSql = m => `select public.duty_save_schedule(jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object('${m}',jsonb_build_object('status','draft','deadline','${m === M1 ? '2027-11-24' : '2027-12-24'}','generated',true)),
 'duties',(select jsonb_agg(to_jsonb(a)) from public.duty_assignments a where publication_id is null and day>='${m}-01' and day<'${nextOf(m)}-01')),${rev},'${m}');`;
/** Plan the month: context, confirm, save and publish, as the dialog does. */
function planSql(m, placed, key, repay, extra) {
  const draft = draftFor(m, placed, key, repay, extra);
  const claim = repay ? `jsonb_build_array(jsonb_build_object('claim',(select k from jsonb_array_elements(v->'actual'->'claims') k where k->>'debtorId'='${repay.debtorId}' and k->>'creditorId'='${repay.creditorId}' and (k->>'units')::int>=2 order by k->>'id' limit 1),'units',2))` : `'[]'::jsonb`;
  return `update context set v=public.duty_generation_context('${m}',${rev});
update context set v=public.duty_confirm_allocation('${m}',jsonb_set(${quote(draft)},'{repayments}',${claim}),'[]','[]',(v->>'revision')::bigint,v->>'fingerprint');
update context set v=public.duty_save_generation('${m}',${quote(placed)},(v->>'revision')::bigint,v->>'fingerprint',123);
${publishSql(m)}`;
}
const setupSql = `begin;
do $$begin if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) or exists(select 1 from public.duty_compensation_events) then raise exception 'Requires empty disposable LOCAL';end if;end$$;
create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select 1822478400000::bigint$$;
insert into auth.users(id,email) values ${ids.map((id, i) => `('${id}','ledger-hunt-${i}@example.invalid')`).join(',')};
insert into public.duty_members(id,email,name,role,status,active,seniority) values ${ids.map((id, i) => `('${id}','ledger-hunt-${i}@example.invalid','Hunt ${i}','${i < 2 ? 'admin' : 'engineer'}','approved',true,${i + 1})`).join(',')};
insert into public.duty_months(month,deadline) values('${M1}','2027-11-24'),('${M2}','2027-12-24');
-- A split weekend in December: Friday and Saturday are separate one-unit duties.
insert into public.duty_assignments(day,end_day) values('${SPLIT}','2027-12-11'),('2027-12-11','2027-12-12');
create function pg_temp.attempt(command text) returns text language plpgsql as $f$begin execute command;return null;exception when others then return sqlerrm;end$f$;
create function pg_temp.attempt_all(commands text[]) returns text language plpgsql as $f$declare c text;begin foreach c in array commands loop execute c;end loop;return null;exception when others then return sqlerrm;end$f$;
-- An engineer asks, the other engineer accepts and the admin approves, or nothing changes.
create function pg_temp.swap(m text,f date,t date) returns text language plpgsql as $f$
declare pub uuid; x public.duty_assignments; y public.duty_assignments; req uuid;
begin
 select current_publication_id into pub from public.duty_months where month=m;
 select * into x from public.duty_assignments where publication_id=pub and day=f;
 select * into y from public.duty_assignments where publication_id=pub and day=t;
 perform set_config('request.jwt.claim.sub',x.primary_id::text,true);
 perform public.duty_request_swap(x.id,y.id,'Hunt',(select revision from public.duty_workspace where id));
 select id into req from public.duty_swap_requests where requester_id=x.primary_id and status in ('awaiting_engineer','awaiting_admin') order by created_at desc limit 1;
 perform set_config('request.jwt.claim.sub',y.primary_id::text,true);
 perform public.duty_resolve_swap(req,'accept',(select revision from public.duty_workspace where id));
 perform set_config('request.jwt.claim.sub','${manager}',true);
 perform public.duty_resolve_swap(req,'approve',(select revision from public.duty_workspace where id));
 return null;
exception when others then return sqlerrm;
end$f$;
grant execute on function pg_temp.attempt(text),pg_temp.attempt_all(text[]),pg_temp.swap(text,date,date) to authenticated;
create temp table context(v jsonb);grant all on context to authenticated;insert into context values(null);
set local request.jwt.claim.sub='${manager}';set local role authenticated;
${planSql(M1, firstPlacement(), 'ledger-hunt-first')}`;

/** Several statements as one step: all of them, or none and the refusal. */
const all = sql => `select jsonb_build_object('error',pg_temp.attempt_all(array[${sql.split(/;\s*\n/).map(x => x.trim().replace(/;$/, '')).filter(Boolean).map(x => `$q$${x}$q$`).join(',')}]));`;
// ---- Persistent psql session: one transaction per sequence, rolled back. ----
function session() {
  const p = spawn('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {stdio: ['pipe', 'pipe', 'pipe']});
  let out = '', err = '', waiting = null, n = 0;
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
  const check = () => {
    if (!waiting) return;
    const i = out.indexOf(waiting.mark);
    if (i >= 0) {const text = out.slice(0, i); out = out.slice(i + waiting.mark.length); const w = waiting; waiting = null; w.resolve(text);}
  };
  p.stdout.on('data', d => {out += d; check();});
  p.stderr.on('data', d => {err += d;});
  let exited = false;
  p.on('exit', () => {exited = true; if (waiting) {const w = waiting; waiting = null; w.reject(Error('psql exited: ' + err));}});
  return {
    run: sql => new Promise((resolve, reject) => {
      if (exited) return reject(Error('psql exited: ' + err));
      const mark = `@@hunt${n++}@@`, timer = setTimeout(() => {if (waiting?.mark === mark) {waiting = null; exited = true; p.kill(); reject(Error('[timeout] step took over 5 minutes'));}}, 300000);
      waiting = {mark, resolve: v => {clearTimeout(timer); resolve(v);}, reject: e => {clearTimeout(timer); reject(e);}};
      p.stdin.write(sql + `\n\\echo ${mark}\n`); check();
    }).then(text => text.split('\n').filter(x => x.startsWith('{')).map(x => JSON.parse(x))),
    close: () => p.stdin.end(), dead: () => exited,
  };
}

// ---- The model: who holds each duty and what each month's own causes owe. ----
const unitsOf = (d, extra) => d.units + 2 * extra;
const zero = () => Object.fromEntries(ids.map(id => [id, 0]));
/** A month as planned: holders, extra points, its own causes' balances, planned points
 * (the plan's targets, plus extra points to whoever had them added), permanent moves and,
 * per duty, who held it before a Temporary change still in effect (rule H1). */
function monthModel(m, placed, repayments = [], extra = {}) {
  const planned = zero();
  for (const d of dutyList(m, extra)) planned[placed[d.id].primary] += d.units;
  return {holders: Object.fromEntries(dutyList(m).map(d => [d.id, placed[d.id].primary])),
    extra: Object.fromEntries(dutyList(m).map(d => [d.id, extra[d.id] ?? 0])), net: zero(), planned, perm: zero(), chain: {},
    repay: repayments.map(r => ({...r, state: 'live'})), stack: [], placed};
}
function nets(model) {
  const total = Object.fromEntries(ids.map(id => [id, 0]));
  for (const m of Object.values(model)) {
    for (const id of ids) total[id] += m.net[id];
    // A live repayment, or one a Temporary replacement worked, counts as done.
    for (const r of m.repay) if (r.state !== 'cancelled') {total[r.debtorId] += r.units; total[r.creditorId] -= r.units;}
  }
  return total;
}
/** The decided rules (2026-11-06), booked against the schedule right before the change:
 * Temporary (and each side of a swap): the replaced holder owes the new one the shared
 * points. Permanent: no debt, unless it returns the duty to someone who held it before a
 * Temporary change still in effect (H1): that is the undo, the earlier debt cancels.
 * Added extra counts for whoever does the duty. Returns whether H1 applied. */
function move(m, day, toId, kind, extra, swap = false) {
  const d = dutyList(m.month).find(x => x.id === day), fromId = m.holders[day];
  const old = unitsOf(d, m.extra[day]), now = unitsOf(d, extra), shared = Math.min(old, now);
  let returned = false;
  if (fromId === toId) m.planned[fromId] += now - old;
  else {
    m.planned[now > old ? toId : fromId] += now - old;
    const chain = m.chain[day] ?? [];
    returned = !swap && kind === 'permanent' && chain.includes(toId);
    const temporary = kind === 'temporary' || returned;
    for (const r of m.repay) if (r.date === day && r.state === 'live') r.state = temporary ? 'worked' : 'cancelled';
    if (temporary) {m.net[fromId] -= shared; m.net[toId] += shared;}
    else {m.perm[fromId] -= shared; m.perm[toId] += shared;}
    m.chain[day] = swap ? [] : kind === 'temporary' ? [...chain, fromId] : returned ? chain.slice(0, chain.lastIndexOf(toId)) : [];
  }
  m.holders[day] = toId; m.extra[day] = extra;
  return returned;
}
const snapshot = m => structuredClone({holders: m.holders, extra: m.extra, net: m.net, planned: m.planned, perm: m.perm, chain: m.chain, repay: m.repay});
/** (f) Per person: points done − (owed to them − they owe) = planned points (less repayments
 * that happen) + permanent in − permanent out. */
function points(model) {
  const done = zero(), owed = zero();
  for (const m of Object.values(model)) {
    for (const d of dutyList(m.month, m.extra)) done[m.holders[d.id]] += d.units;
    for (const id of ids) owed[id] += m.planned[id] + m.perm[id];
    for (const r of m.repay) if (r.state !== 'cancelled') {owed[r.debtorId] -= r.units; owed[r.creditorId] += r.units;}
  }
  return {done, owed};
}
const differ = (a, b) => ids.filter(id => a[id] !== b[id]).map(id => `${short(id)}: ${a[id]} vs ${b[id]}`).join(', ');

// ---- One sequence. `script` replays fixed operations (shrinking); otherwise random. ----
async function sequence(db, seed, script, ops = [], log = []) {
  let random = seed * 7919 + 17;
  const rand = n => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0) % n;
  await db.run(setupSql);
  const model = {[M1]: Object.assign(monthModel(M1, firstPlacement()), {month: M1})};
  const read = async () => {
    const [row] = await db.run(`reset role;select jsonb_build_object('view',duty_private.compensation_view(duty_private.compensation_state()),
 'holders',(select coalesce(jsonb_object_agg(a.day,a.primary_id),'{}') from public.duty_assignments a join public.duty_months m on a.publication_id=m.current_publication_id),
 'published',(select coalesce(jsonb_agg(month order by month),'[]') from public.duty_months where status='published'));set local role authenticated;`);
    return row;
  };
  const planned = view => {
    const total = {...view.net};
    for (const c of view.contributions) if (c.status === 'pending' || c.status === 'held') {total[c.claim.debtorId] += c.capacity.units; total[c.claim.creditorId] -= c.capacity.units;}
    return Object.fromEntries(ids.map(id => [id, total[id] ?? 0]));
  };
  const check = async (label, expectSame) => {
    const state = await read(), ledger = planned(state.view);
    // (e) The SQL ledger replays exactly in the TypeScript core.
    const ordered = v => {v = structuredClone(v); for (const k of ['members', 'lots', 'contributions', 'settlements', 'publications']) v[k]?.sort((p, q) => p.id.localeCompare(q.id)); return v;};
    assert.deepEqual(ordered(state.view), ordered(replay(state.view.events)), `${label}: [parity] SQL and TypeScript core disagree`);
    for (const mm of Object.values(model)) for (const [day, holder] of Object.entries(mm.holders))
      assert.equal(state.holders[day], holder, `${label}: [model] holder of ${day}`);
    // (a)/(b) Every balance has a cause: Temporary replacements and planned repayments only.
    const expected = nets(model);
    assert.deepEqual(ledger, expected, `${label}: [causes] ledger ≠ causes (${differ(ledger, expected)})`);
    // (f) Every point is accounted for, per person.
    const {done, owed} = points(model), account = Object.fromEntries(ids.map(id => [id, done[id] - ledger[id]]));
    assert.deepEqual(account, owed, `${label}: [points] done − balance ≠ planned + permanent (${differ(account, owed)})`);
    // (c) An exact undo restores the balances before what it undid.
    if (expectSame) assert.deepEqual(ledger, expectSame, `${label}: [undo] left ${differ(ledger, expectSame)}`);
    // (d) Plan the month and Reset start from the other month's entries only.
    for (const m of state.published) {
      const [row] = await db.run(`update context set v=public.duty_generation_context('${m}',${rev});reset role;select jsonb_build_object('ctx',(select v-'facts' from context));set local role authenticated;`);
      const ctx = row.ctx, other = Object.fromEntries(Object.entries(model).filter(([k]) => k !== m));
      if (ctx.replanBlocked) {
        assert.match(ctx.replanBlocked, /^review-replan-later:2028-01$/, `${label}: [plan] ${m} blocked`);
        assert.ok(m === M1 && model[M2]?.repay.some(r => r.state === 'live'), `${label}: [plan] ${m} blocked without a later repayment`);
        continue;
      }
      const start = planned(ctx.actual), wanted = nets(other);
      // A debt of December's that January's live repayment relies on stays booked (decision
      // 2026-11-07): December's plan starts from it too, as fixed points.
      if (m === M1) for (const r of model[M2]?.repay ?? []) if (r.state === 'live') {wanted[r.debtorId] -= r.units; wanted[r.creditorId] += r.units;}
      assert.deepEqual(start, wanted, `${label}: [plan] Plan the month ${m} starts from ${differ(start, wanted)}`);
      const projected = Object.fromEntries(ids.map(id => [id, ctx.projected.net[id] ?? 0]));
      assert.deepEqual(projected, Object.fromEntries(ids.map(id => [id, ctx.actual.net[id] ?? 0])), `${label}: [plan] ${m} projection moved before opening`);
    }
    return ledger;
  };
  let balances = await check('published');
  const choose = () => {
    const months = Object.keys(model), m = months[rand(months.length)], mm = model[m];
    // Often the duty touched last (re-edit, swap an edited duty) or a planned repayment duty.
    const hot = [...mm.stack.flatMap(s => s.undo.day ? [s.undo.day] : s.undo.a ? [s.undo.a, s.undo.b] : []).slice(-2),
      ...mm.repay.map(p => p.date)];
    const days = Object.keys(mm.holders), pick = () => hot.length && rand(3) === 0 ? hot[rand(hot.length)] : days[rand(days.length)];
    const r = rand(100);
    // January publishes once December has a debt it can repay, or late in the sequence.
    if (!model[M2] && r < 15 && (Object.values(model[M1].net).some(n => n >= 2) || rand(3) === 0)) return {op: 'publish-january'};
    if (r < 35) {const day = pick(), d = dutyList(m).find(x => x.id === day);
      return {op: 'edit', m, day, to: ids[(ids.indexOf(mm.holders[day]) + 1 + rand(ids.length - 1)) % ids.length], kind: 'temporary', extra: !d.weekendId && rand(4) === 0 ? 1 : 0};}
    if (r < 55) {const day = pick(), d = dutyList(m).find(x => x.id === day);
      // Half the time, back to someone who held it before a Temporary change (H1), when there is one.
      const earlier = mm.chain[day] ?? [], back = earlier.length && rand(2) === 0 ? earlier[rand(earlier.length)] : null;
      return {op: 'edit', m, day, to: back ?? ids[(ids.indexOf(mm.holders[day]) + 1 + rand(ids.length - 1)) % ids.length], kind: 'permanent', extra: !d.weekendId && rand(4) === 0 ? 1 : 0};}
    if (r < 72) {const a = pick(), b = pick(); return {op: 'swap', m, a, b};}
    if (r < 82) return {op: 'undo', m};
    if (r < 88) return {op: 'republish', m};
    if (r < 94) return {op: 'delete', m};
    return {op: 'replan', m};
  };
  const total = script ? script.length : steps;
  for (let i = 0; i < total; i++) {
    const op = script ? script[i] : choose(), mm = op.m && model[op.m];
    if (op.m && !mm) continue;
    ops.push(op);
    let label = `#${i} ${JSON.stringify(op).replaceAll(/75000000-0000-0000-0000-0000000000/g, 'm')}`, error = null, expectSame;
    const before = snapshot(mm ?? {}), was = balances, at = ops.length - 1;
    const undone = last => last.at === at - 1 ? last.balances : undefined;
    if (op.op === 'publish-january') {
      if (model[M2]) continue;
      // Repay the oldest December debt of at least two units, if there is one.
      const view = (await read()).view;
      const claim = view.claims.filter(c => c.units >= 2).sort((p, q) => p.id.localeCompare(q.id))[0];
      const repay = claim && {debtorId: claim.debtorId, creditorId: claim.creditorId};
      const placed = nextPlacement(repay);
      [{error}] = await db.run(all(planSql(M2, placed, 'ledger-hunt-january', repay)));
      assert.equal(error, null, `${label}: [refused] January publishes`);
      const pub = (await read()).view.publications.find(p => p.month === M2);
      model[M2] = Object.assign(monthModel(M2, placed, pub.reservations.map(r => ({date: r.capacity.date, debtorId: r.claim.debtorId, creditorId: r.claim.creditorId, units: r.capacity.units}))), {month: M2});
      label += repay ? ` repays ${short(repay.debtorId)}→${short(repay.creditorId)}` : '';
    } else if (op.op === 'edit') {
      const from = mm.holders[op.day], oldExtra = mm.extra[op.day];
      if (from === op.to && oldExtra === op.extra) continue;
      [{error}] = await db.run(`select jsonb_build_object('error',pg_temp.attempt($q$select public.duty_edit_published_duty(${current(op.m)},'${op.day}','${op.to}',${op.extra},0,'${op.kind}',${rev},'')$q$));`);
      assert.equal(error, null, `${label}: [refused] edit`);
      // The inverse of a return (H1) is the Temporary change it undid.
      const returned = move(mm, op.day, op.to, op.kind, op.extra);
      if (returned) label += ' (returns: undo)';
      mm.stack.push({before, balances: was, at, undo: {op: 'edit', m: op.m, day: op.day, to: from, kind: returned ? 'temporary' : op.kind, extra: oldExtra}});
    } else if (op.op === 'swap' || (op.op === 'undo' && mm.stack.at(-1)?.undo.op === 'swap')) {
      const sw = op.op === 'swap' ? op : mm.stack.at(-1).undo;
      const [x, y] = [mm.holders[sw.a], mm.holders[sw.b]];
      if (x === y || x === manager || y === manager) continue;
      [{error}] = await db.run(`select jsonb_build_object('error',pg_temp.swap('${op.m}','${sw.a}','${sw.b}'));`);
      // Swap rules (weekends, back-to-back days, availability) may refuse: nothing changes.
      if (error) {log.push(`${label}: refused (${error})`); if (op.op === 'swap') {await check(label); continue;}
        assert.fail(`${label}: [refused] swapping back (${error})`);}
      if (op.op === 'undo') expectSame = undone(mm.stack.at(-1));
      mm.stack.push({before, balances: was, at, undo: {op: 'swap', m: op.m, a: sw.a, b: sw.b}});
      move(mm, sw.a, y, 'temporary', mm.extra[sw.a], true); move(mm, sw.b, x, 'temporary', mm.extra[sw.b], true);
    } else if (op.op === 'undo') {
      const last = mm.stack.at(-1);
      // A republish has no inverse edit; deleting it is the undo.
      if (last?.undo.op !== 'edit') continue;
      const u = last.undo;
      [{error}] = await db.run(`select jsonb_build_object('error',pg_temp.attempt($q$select public.duty_edit_published_duty(${current(op.m)},'${u.day}','${u.to}',${u.extra},0,'${u.kind}',${rev},'')$q$));`);
      assert.equal(error, null, `${label}: [refused] undo`);
      expectSame = undone(last);
      const holder = mm.holders[u.day], extraNow = mm.extra[u.day], returned = move(mm, u.day, u.to, u.kind, u.extra);
      mm.stack.push({before, balances: was, at, undo: {...u, to: holder, extra: extraNow, kind: returned ? 'temporary' : u.kind}});
    } else if (op.op === 'republish') {
      [{error}] = await db.run(all(`select public.duty_restore_publication(${current(op.m)},${rev});\n${publishSql(op.m)}`));
      assert.equal(error, null, `${label}: [refused] reopen and republish`);
      mm.stack.push({before, balances: was, at, undo: {op: 'none'}});
    } else if (op.op === 'delete') {
      const last = mm.stack.at(-1);
      if (!last) continue;
      [{error}] = await db.run(`select jsonb_build_object('error',pg_temp.attempt($q$select public.duty_delete_publication(${current(op.m)},${rev})$q$));`);
      assert.equal(error, null, `${label}: [refused] deleting the live version`);
      mm.stack.pop(); Object.assign(mm, structuredClone(last.before)); expectSame = undone(last);
    } else if (op.op === 'replan') {
      const placed = mm.placed;
      [{error}] = await db.run(`select jsonb_build_object('error',pg_temp.attempt($q$select public.duty_restore_publication(${current(op.m)},${rev})$q$));`);
      assert.equal(error, null, `${label}: [refused] reopen`);
      [{error}] = await db.run(all(planSql(op.m, placed, `ledger-hunt-replan-${i}`, null, mm.extra)));
      if (error) {
        // Only a later month's live repayment of this month's points may block it: by name when
        // reversing would change it, or because this plan would book that kept debt again
        // instead of holding it as fixed points (decision 2026-11-07).
        assert.ok(op.m === M1 && /review-replan-later:2028-01|invalid-repaid-later/.test(error) && model[M2]?.repay.some(r => r.state === 'live'), `${label}: [refused] re-plan (${error})`);
        [{error}] = await db.run(`select jsonb_build_object('error',pg_temp.attempt($q$select public.duty_cancel_draft('${op.m}',${rev})$q$));`);
        assert.equal(error, null, `${label}: [refused] cancel draft`); log.push(`${label}: blocked by a January repayment`);
        await check(label); continue;
      }
      model[op.m] = Object.assign(monthModel(op.m, placed, [], mm.extra), {month: op.m});
    }
    log.push(label);
    balances = await check(label, expectSame);
  }
  await db.run('reset role;rollback;');
  return {ops, log};
}

const kindOf = e => /\[(\w+)\]/.exec(String(e?.message))?.[1] ?? 'error';
let db = session();
async function attempt(_, seed, script) {
  if (db.dead()) db = session();
  const ops = [], log = [];
  try {await sequence(db, seed, script, ops, log); return {ops, log};}
  catch (e) {await db.run('reset role;rollback;').catch(() => {}); return {ops, log, failure: e};}
}
const found = [];
let sequences = 0;
// Minimal sequences of the bugs this hunt found (decision 2026-11-06), replayed first.
const owner13 = firstPlacement()['2027-12-13'].primary;
const regressions = [
  ['swap, then Permanent to a third engineer: no debt', [{op: 'swap', m: M1, a: '2027-12-13', b: '2027-12-14'},
    {op: 'edit', m: M1, day: '2027-12-13', to: ids[1], kind: 'permanent', extra: 0}]],
  ['Permanent edit, then delete the live version: no debt', [{op: 'edit', m: M1, day: '2027-12-13', to: ids[1], kind: 'permanent', extra: 0},
    {op: 'delete', m: M1}]],
  ['weighted swap (weekday ↔ split Saturday), then Reopen + Publish', [{op: 'swap', m: M1, a: '2027-12-30', b: '2027-12-11'}, {op: 'republish', m: M1}]],
  ['extra points on a published duty, then Plan the month → Reset → Publish', [{op: 'publish-january'},
    {op: 'edit', m: M2, day: '2028-01-02', to: ids[5], kind: 'temporary', extra: 1}, {op: 'replan', m: M2}]],
  ['H1: Temporary, then Permanent back to the earlier holder: no debt', [{op: 'edit', m: M1, day: '2027-12-13', to: ids[1], kind: 'temporary', extra: 0},
    {op: 'edit', m: M1, day: '2027-12-13', to: owner13, kind: 'permanent', extra: 0}]],
];
for (const [label, script] of process.env.LEDGER_HUNT_SKIP_REGRESSIONS ? [] : regressions) {
  const run = await attempt(db, 0, script);
  sequences++;
  if (run.failure) {found.push(label); console.log(`FAIL regression ${label}\n  → ${run.failure.message}`);}
  else assert.equal(run.log.length, script.length, `regression ${label} ran every step: ${run.log.join(' | ')}`);
}
for (let seed = firstSeed; seed < firstSeed + seeds; seed++) {
  let run = await attempt(db, seed);
  sequences++;
  if (process.env.LEDGER_HUNT_VERBOSE) console.log(`seed ${seed}:\n  ${run.log.join('\n  ')}`);
  if (!run.failure) continue;
  // Shrink: replay the recorded operations, dropping each one while the same check still fails.
  const kind = kindOf(run.failure);
  let script = run.ops;
  for (let i = script.length - 2; i >= 0; i--) {
    const shorter = script.filter((_, j) => j !== i), again = await attempt(db, seed, shorter);
    if (again.failure && kindOf(again.failure) === kind) {script = shorter; run = again;}
  }
  found.push(seed);
  const plain = v => JSON.stringify(v).replaceAll(/75000000-0000-0000-0000-0000000000/g, 'm');
  console.log(`FAIL seed ${seed} [${kind}], minimal sequence:\n  ${script.map(plain).join('\n  ')}\n  steps: ${run.log.join(' | ')}\n  → ${run.failure.message}`);
}
db.close();
if (found.length) {console.log(`FAIL: ${found.length} of ${sequences} ledger hunt sequences (seeds ${found.join(', ')})`); process.exit(1);}
console.log(`PASS: ${sequences} random ledger sequences of up to ${steps} steps keep (a) causes, (b) no Permanent debt, (c) exact undo, (d) plans from other months only, (e) SQL = TypeScript core, (f) every point accounted for`);
