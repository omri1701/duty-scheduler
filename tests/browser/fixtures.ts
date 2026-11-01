import {test as base, expect, type Page} from '@playwright/test';
import {addDays, blocks, dayOf, specialAt} from '../../lib/rota/engine';
import {canManage, fromSnapshot, type Snapshot, type DutyRow, type SwapRequest} from '../../lib/supabase/snapshot';
import {canonicalDuties, coverageStart} from '../../lib/scheduling/calendar';
import {validateGeneration, type PrimaryAssignments} from '../../lib/scheduling/validate';
import type {AllocationDraft} from '../../lib/allocation/types';
import type {Approval, GenerationInput} from '../../lib/scheduling/types';
import {PROJECTS,resolveEnvironment} from '../../lib/supabase/environment';
import type {Balance} from '../../lib/supabase/balance';
import type {CompensationEvent} from '../../lib/compensation/types';

export const NOW = '2026-10-09T10:00:00Z', MONTH = '2026-11';
export const ids = Object.fromEntries(['admin', 'a', 'b', 'c', 'd', 'e', 'pending'].map((key, i) => [key, `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
const pub = '20000000-0000-4000-8000-000000000010';
export type Identity = 'admin' | 'a' | 'b' | 'c' | 'd' | 'e' | 'pending' | 'signed-out' | 'rejected' | 'inactive';
type Call = {name: string; params: Record<string, unknown>; user: string};

export function seed(): Snapshot {
  const members = Object.entries(ids).map(([key, id], i) => ({id, name: ['Avery Admin', 'Alex Atlas', 'Blair Birch', 'Casey Cedar', 'Drew Dale', 'Eden Elm', 'Pat Pending'][i], email: `${key}@example.invalid`, role: key === 'admin' ? 'admin' : 'engineer', status: key === 'pending' ? 'pending' : 'approved', active: true, seniority: i, color: ['#adc9ee', '#f0ba95', '#c9b1de', '#9bcfbe', '#eacb96', '#b6c8d1', '#adc9ee'][i]}));
  // Fixed rows independent of the generator: snapshots catch renderer changes too.
  const specials = [{id: 'holiday', title: 'Holiday coverage', start: '2026-11-12', end: '2026-11-13', extra: 2}, {id: 'weekend-holiday', title: 'Weekend holiday', start: '2026-11-20', end: '2026-11-22', extra: 2}];
  const duties: DutyRow[] = blocks(MONTH, specials).map((b, i) => ({
    id: `duty-${i}`, publication_id: pub, day: b.start, end_day: b.end,
    primary_id: members[i % 6].id, secondary_id: b.start === '2026-11-02' ? ids.c : null,
    locked: false, manager_override: false, title: b.title ?? '', extra_points: specialAt(specials, b.start)?.extra ?? 0,
    saturday_extra_points: b.end === addDays(b.start, 2) ? specialAt(specials, addDays(b.start, 1))?.extra ?? 0 : 0, points: b.points,
  }));
  duties.find(d => d.day === '2026-11-02')!.primary_id = ids.a;
  duties.find(d => d.day === '2026-11-03')!.primary_id = ids.b;
  return {revision: 1, members, months: [{month: MONTH, deadline: '2026-10-25', status: 'draft', generated: true, current_publication_id: pub, publication_sequence: 1}],
    constraints: [{member_id: ids.a, day: '2026-11-04', kind: 'no', note: 'Synthetic vacation'}],
    assignments: [...duties, ...duties.map(d => ({...d, id: `${d.id}-draft`, publication_id: null}))],
    publications: [{id: pub, month: MONTH, version: 1, published_at: NOW, published_by: ids.admin}],
    roles: [{code: 'admin', label: 'Admin', can_manage: true}, {code: 'engineer', label: 'Engineer', can_manage: false}],
    memberStatuses: [], monthStatuses: [], constraintTypes: [], swapRequests: []};
}

// A deliberately small transport fake, not a substitute for PostgreSQL/RLS tests.
// Unexpected endpoints and stale client revisions fail closed; no network fallback.
export class Backend {
  url: string = PROJECTS.dev;
  runtimeOrigin?: string;
  raw = seed();
  calls: Call[] = [];
  authGate?: Promise<void>;
  configGate?: Promise<void>;
  loadGate?: Promise<void>;
  authFailure = false;
  invalidated = false;
  failNextSave = false;
  /** Display-only projection served by duty_balance; null serves zero for everyone. */
  balance: Balance | null = null;
  googleEnabled = false;
  allocations = new Map<string, {draft: AllocationDraft; locks: NonNullable<GenerationInput['locks']>; approvals: Approval[]; generation?: unknown}>();
  generationNow = Date.parse(NOW);
  failGenerationSave = false;
  /** Compensation ledger served with the generation context; empty by default. */
  events: readonly CompensationEvent[] = [];
  oauthRequests: URL[] = [];
  generationEnvelope(month: string) {
    const state = fromSnapshot(this.raw, ids.admin);
    const calendar = {specials: state.specials, splitWeekends: state.splitWeekends};
    const metadata = this.allocations.get(month);
    const members = this.raw.members.map(m => ({id: m.id, active: m.active, approved: m.status === 'approved', eligible: m.active && m.status === 'approved', ...(m.no_weekends ? {noWeekends: true} : {})}));
    return {revision: this.raw.revision, actualAtMs: this.generationNow, coverageStartMs: coverageStart(month, calendar),
      generationAllowed: this.generationNow < coverageStart(month, calendar), fingerprint: `fixture-${this.raw.revision}`, accountingFingerprint: this.events.length ? `events-${this.events.length}` : 'empty-events', actual: {events: this.events},
      facts: {month, members, seniority: this.raw.members.filter(m => m.active && m.status === 'approved').sort((a, b) => a.seniority - b.seniority).map(m => m.id),
        duties: canonicalDuties(month, calendar).map(d => ({id: d.id, startDate: d.startDate, endDate: d.endDate, units: d.units,
          primary: state.assignments[d.id]?.primary || null, secondary: state.assignments[d.id]?.secondary || null,
          title: (specialAt(state.specials, d.startDate) ?? (d.dates.length === 2 ? specialAt(state.specials, d.dates[1]) : undefined))?.title ?? '',
          extra: specialAt(state.specials, d.startDate)?.extra ?? 0, weekendId: d.weekendId ?? null,
          ...(d.saturdayUnits !== undefined && d.saturdayUnits !== 1 ? {saturdayExtra: (d.saturdayUnits - 1) / 2} : {})})),
        neighbors: [], constraints: state.constraints, allocation: metadata?.draft ?? null, allocationId: metadata ? 'fixture-allocation' : null,
        sourcePublicationId: null, generation: metadata?.generation ?? null, locks: canonicalDuties(month, calendar).flatMap(d => state.assignments[d.id]?.locked ? [{dutyId: d.id, engineer: state.assignments[d.id].primary}] : []), approvals: metadata?.approvals ?? []}};
  }
  snapshot(user: string) {
    const raw = structuredClone(this.raw), admin = canManage(raw, user);
    const member = raw.members.find(m => m.id === user)!;
    // Mirrors the migrated column default; legacy rows are covered by unit tests.
    raw.assignments = raw.assignments.map(d => ({...d, locked: d.locked ?? false}));
    if (!member || member.status !== 'approved' || !member.active) return {...raw, revision: null, members: member ? [member] : [], months: [], constraints: [], assignments: [], publications: [], swapRequests: []};
    if (!admin) {
      raw.members = raw.members.filter(m => m.status === 'approved');
      raw.constraints = raw.constraints.filter(c => c.member_id === user);
      const live = new Set(raw.months.map(m => m.current_publication_id));
      raw.assignments = raw.assignments.filter(d => live.has(d.publication_id));
      raw.publications = raw.publications.filter(p => live.has(p.id));
    }
    raw.swapRequests = raw.swapRequests!.filter(r => r.requester_id === user || (r.other_id === user && r.status === 'awaiting_engineer') || (admin && r.status === 'awaiting_admin'));
    return raw;
  }
  rpc(name: string, p: Record<string, unknown>, user: string) {
    this.calls.push({name, params: p, user});
    if (name === 'duty_join') {
      if (!this.raw.members.some(m=>m.id===user)) {
        const member=seed().members.find(m=>m.id===user);
        if (!member) throw Error('Unknown synthetic identity');
        this.raw.members.push({...member,name:String(p.p_name),role:'engineer',status:'pending',active:false});
      }
      return null;
    }
    if (name === 'duty_load') return this.snapshot(user);
    if (name === 'duty_balance') {
      const member = this.raw.members.find(m => m.id === user);
      if (!member || member.status !== 'approved' || !member.active) throw Error('Member access required');
      const all = this.balance ?? {net: Object.fromEntries(this.raw.members.map(m => [m.id, 0])), lines: []};
      // Mirrors the database scope: members receive only their own row and relationships.
      return canManage(this.raw, user) ? all : {net: user in all.net ? {[user]: all.net[user]} : {}, lines: all.lines.filter(l => l.memberId === user)};
    }
    expect(p.p_revision).toBe(this.raw.revision);
    const admin = canManage(this.raw, user);
    if (name === 'duty_generation_context') {
      expect(admin).toBe(true); return this.generationEnvelope(String(p.p_month));
    } else if (name === 'duty_confirm_allocation') {
      expect(admin).toBe(true); expect(p.p_fingerprint).toBe(`fixture-${this.raw.revision}`);
      this.allocations.set(String(p.p_month), {draft: p.p_allocation as AllocationDraft, locks: p.p_locks as NonNullable<GenerationInput['locks']>, approvals: p.p_approvals as Approval[]});
      for (const d of this.raw.assignments.filter(d => d.publication_id === null && (dayOf(d.day) === 6 ? addDays(d.day, -1) : d.day).slice(0, 7) === p.p_month)) d.locked = (p.p_locks as NonNullable<GenerationInput['locks']>).some(l => l.dutyId === d.day);
      this.raw.revision!++; return this.generationEnvelope(String(p.p_month));
    } else if (name === 'duty_save_generation') {
      expect(admin).toBe(true); expect(p.p_fingerprint).toBe(`fixture-${this.raw.revision}`);
      if (this.failGenerationSave) {this.failGenerationSave = false; throw Error('Synthetic stale generation. Refresh and review.');}
      const month = String(p.p_month), assignments = p.p_assignments as PrimaryAssignments, meta = this.allocations.get(month)!;
      const envelope = this.generationEnvelope(month), f = envelope.facts;
      const metrics = validateGeneration({month, sourceRevision: String(this.raw.revision), calendar: {specials: fromSnapshot(this.raw, ids.admin).specials, splitWeekends: fromSnapshot(this.raw, ids.admin).splitWeekends}, members: f.members,
        targets: Object.fromEntries(Object.entries(meta.draft.targetsUnits).map(([id, u]) => [id, u / 2])), constraints: f.constraints, locks: meta.locks, approvals: meta.approvals,
        secondary: Object.fromEntries(f.duties.filter(d => d.secondary).map(d => [d.id, d.secondary!]))}, assignments);
      if (!envelope.generationAllowed) throw Error('Synthetic stale generation-window-closed');
      const owns = (d: DutyRow) => (dayOf(d.day) === 6 ? addDays(d.day, -1) : d.day).slice(0, 7) === month;
      this.raw.assignments = this.raw.assignments.filter(d => d.publication_id !== null || !owns(d));
      this.raw.assignments.push(...f.duties.map(d => ({id: `generated-${d.id}`, publication_id: null, day: d.startDate, end_day: d.endDate, primary_id: assignments[d.id].primary,
        secondary_id: d.secondary, title: d.title, extra_points: d.extra, saturday_extra_points: d.saturdayExtra ?? 0, points: d.units / 2, locked: f.locks.some(l => l.dutyId === d.id), manager_override: false})));
      let m = this.raw.months.find(m => m.month === month);
      if (!m) {m = {month, deadline: addDays(month + '-01', -7), status: 'draft', generated: true, current_publication_id: null, publication_sequence: 0}; this.raw.months.push(m);}
      m.generated = true; meta.generation = {seed: p.p_seed, metrics};
      this.raw.revision!++; return this.generationEnvelope(month);
    } else if (name === 'duty_save_schedule') {
      expect(admin).toBe(true);
      if (this.failNextSave) {this.failNextSave = false; throw Error('Synthetic stale revision. Refresh and try again.');}
      const state = p.p_state as {team:{id:string;color:string;active:boolean}[];duties: Omit<DutyRow, 'id' | 'publication_id' | 'points'>[]; months: Record<string, {deadline: string; status: 'draft' | 'published'; generated: boolean}>};
      state.team.forEach((member, seniority) => Object.assign(this.raw.members.find(m => m.id === member.id)!, member, {seniority}));
      this.raw.members.sort((a,b) => a.seniority - b.seniority);
      const draftIds = new Map(this.raw.assignments.filter(d => d.publication_id === null).map(d => [d.day, d.id]));
      const owns = (d: DutyRow) => (dayOf(d.day) === 6 ? addDays(d.day, -1) : d.day).slice(0,7);
      this.raw.assignments = this.raw.assignments.filter(d => d.publication_id !== null || !state.months[owns(d)] || state.months[owns(d)].status === 'published' && p.p_publish !== owns(d));
      // Mirrors the stored points column: every holiday date adds its own extra.
      this.raw.assignments.push(...state.duties.map((d, i) => ({...d, id: draftIds.get(d.day) ?? `saved-${i}`, publication_id: null,
        points: d.end_day === addDays(d.day, 2) ? 1 + d.extra_points + (d.saturday_extra_points ?? 0) : ([5, 6].includes(dayOf(d.day)) ? .5 : 1) + d.extra_points})));
      for (const [month, value] of Object.entries(state.months)) {
        const metadata = this.allocations.get(month);
        if (metadata) metadata.locks = this.raw.assignments.filter(d => d.publication_id === null && d.locked && owns(d) === month).map(d => ({dutyId: d.day, engineer: d.primary_id!}));
        let m = this.raw.months.find(m => m.month === month);
        if (!m) {m = {month, ...value, current_publication_id: null, publication_sequence: 0}; this.raw.months.push(m);}
        Object.assign(m, value);
        if (p.p_publish === month) this.publish(month);
      }
    } else if (name === 'duty_set_constraints') {
      expect(admin || p.p_member === user).toBe(true);
      const days = p.p_days as string[];
      this.raw.constraints = this.raw.constraints.filter(c => c.member_id !== p.p_member || !days.includes(c.day));
      if (p.p_kind !== 'clear') this.raw.constraints.push(...days.map(day => ({member_id: p.p_member as string, day, kind: p.p_kind as 'no' | 'prefer', note: p.p_note as string})));
    } else if (name === 'duty_add_temporary_member') {
      expect(admin).toBe(true);
      if (this.failNextSave) {this.failNextSave=false;throw Error('Synthetic stale revision. Refresh and try again.');}
      const id = `22000000-0000-4000-8000-${String(this.raw.revision).padStart(12,'0')}`;
      this.raw.members.push({id,name:String(p.p_name).trim(),email:null,is_temporary:true,role:'engineer',status:'approved',active:true,seniority:this.raw.members.length,color:'#adc9ee'});
      this.raw.revision!++; return id;
    } else if (name === 'duty_rename_temporary_member') {
      expect(admin).toBe(true);
      const member=this.raw.members.find(m=>m.id===p.p_member&&m.is_temporary)!;
      expect(member).toBeTruthy();member.name=String(p.p_name).trim();
    } else if (name === 'duty_set_no_weekends') {
      expect(admin).toBe(true); expect(typeof p.p_no_weekends).toBe('boolean');
      const member = this.raw.members.find(m => m.id === p.p_member && m.status === 'approved')!;
      expect(member).toBeTruthy(); member.no_weekends = p.p_no_weekends as boolean;
    } else if (name === 'duty_rename_self') {
      this.raw.members.find(m => m.id === user)!.name = p.p_name as string;
    } else if (name === 'duty_review_member') {
      expect(admin).toBe(true);
      this.raw.members.find(m => m.id === p.p_member)!.status = p.p_status as string;
    } else if (name === 'duty_restore_publication') {
      expect(admin).toBe(true);
      const publication = this.raw.publications.find(v => v.id === p.p_publication)!;
      const owns = (d: DutyRow) => (dayOf(d.day) === 6 ? addDays(d.day, -1) : d.day).slice(0,7) === publication.month;
      this.raw.assignments = this.raw.assignments.filter(d => d.publication_id !== null || !owns(d));
      this.raw.assignments.push(...this.raw.assignments.filter(d => d.publication_id === publication.id && owns(d)).map(d => ({...d, id: d.id + '-restored', publication_id: null})));
      this.raw.months.find(m => m.month === publication.month)!.status = 'draft';
    } else if (name === 'duty_cancel_draft') {
      expect(admin).toBe(true);
      if (this.failNextSave) {this.failNextSave = false; throw Error('Synthetic stale revision. Refresh and try again.');}
      const m = this.raw.months.find(m => m.month === p.p_month)!;
      expect(m.status).toBe('draft'); expect(m.current_publication_id).toBeTruthy();
      const owns = (d: DutyRow) => (dayOf(d.day) === 6 ? addDays(d.day, -1) : d.day).slice(0,7) === m.month;
      this.raw.assignments = this.raw.assignments.filter(d => d.publication_id !== null || !owns(d));
      m.status = 'published'; m.generated = true;
    } else if (name === 'duty_request_swap') {
      const from = this.raw.assignments.find(d => d.id === p.p_from)!, to = this.raw.assignments.find(d => d.id === p.p_to)!;
      expect(from.primary_id).toBe(user); expect(to.primary_id).not.toBe(user);
      this.raw.swapRequests!.unshift({id: `request-${this.raw.revision}`, month: MONTH, source_publication_id: from.publication_id, requester_id: user, other_id: to.primary_id!, from_day: from.day, from_end_day: from.end_day, to_day: to.day, to_end_day: to.end_day, explanation: p.p_explanation as string, status: 'awaiting_engineer', accepted_by: null, accepted_at: null, created_at: NOW, resolved_at: null, resolved_by: null, result_publication_id: null, override_reason: ''});
    } else if (name === 'duty_delete_publication') {
      expect(admin).toBe(true);
      const publication = this.raw.publications.find(v => v.id === p.p_publication)!;
      this.raw.publications = this.raw.publications.filter(v => v.id !== publication.id);
      this.raw.assignments = this.raw.assignments.filter(d => d.publication_id !== publication.id);
      const m = this.raw.months.find(m => m.month === publication.month)!;
      if (m.current_publication_id === publication.id) {
        m.current_publication_id = this.raw.publications.filter(v => v.month === m.month).sort((a, b) => b.version - a.version)[0]?.id ?? null;
        if (!m.current_publication_id) m.status = 'draft';
      }
    } else if (name === 'duty_resolve_swap') {
      const r = this.raw.swapRequests!.find(r => r.id === p.p_request)!, action = p.p_action as string;
      if (this.invalidated) {r.status = 'invalidated'; this.invalidated = false; this.raw.revision!++; return 'invalidated';}
      if (['accept', 'decline'].includes(action)) {expect(user).toBe(r.other_id); expect(r.status).toBe('awaiting_engineer');}
      if (['approve', 'reject'].includes(action)) {expect(admin).toBe(true); expect(r.status).toBe('awaiting_admin');}
      if (action === 'cancel') expect(user).toBe(r.requester_id);
      r.status = ({accept: 'awaiting_admin', decline: 'declined', approve: 'approved', reject: 'rejected', cancel: 'cancelled'} as Record<string, SwapRequest['status']>)[action];
      if (action === 'accept') {r.accepted_by = user; r.accepted_at = NOW;}
      if (action === 'approve') {
        const current = this.raw.months[0].current_publication_id;
        const rows = this.raw.assignments.filter(d => d.publication_id === current).map(d => ({...d}));
        const from = rows.find(d => d.day === r.from_day)!, to = rows.find(d => d.day === r.to_day)!;
        [from.primary_id, to.primary_id] = [to.primary_id, from.primary_id];
        r.result_publication_id = this.publish(MONTH, rows);
      }
      r.override_reason = p.p_override_reason as string;
    } else throw Error(`Unexpected RPC: ${name}`);
    this.raw.revision!++;
    return null;
  }
  publish(month: string, rows?: DutyRow[]) {
    const m = this.raw.months.find(m => m.month === month)!;
    if (!rows) {
      const owns = (d: DutyRow) => (dayOf(d.day) === 6 ? addDays(d.day, -1) : d.day).slice(0,7) === month;
      rows = this.raw.assignments.filter(d => d.publication_id === null && owns(d));
      this.raw.assignments = this.raw.assignments.filter(d => d.publication_id !== null || !owns(d));
      m.status = 'published';
    }
    const id = `publication-${++m.publication_sequence}`;
    this.raw.publications.push({id, month, version: m.publication_sequence, published_at: NOW, published_by: ids.admin});
    this.raw.assignments.push(...rows.map(d => ({...d, id: `${id}-${d.day}`, publication_id: id})));
    m.current_publication_id = id;
    return id;
  }
}

type Fixtures = {backend: Backend; openApp: (identity?: Identity, page?: Page, options?: {waitForReady?: boolean; oauthReturn?: boolean}) => Promise<Page>};
export const test = base.extend<Fixtures>({
  backend: async ({}, provide) => {await provide(new Backend());},
  openApp: async ({page, backend, baseURL}, provide) => {
    const attached = new Set<Page>(), errors: string[] = [], unexpected: string[] = [];
    await provide(async (identity = 'admin', target = page, {waitForReady = true, oauthReturn = false} = {}) => {
      if (!attached.has(target)) {
        attached.add(target);
        target.on('pageerror', error => errors.push(error.message));
        await target.clock.setFixedTime(new Date(NOW));
        await target.addInitScript(() => {
          // Only the generator seed is fixed; IDs still use the native UUID API.
          const original = crypto.getRandomValues.bind(crypto) as <T extends ArrayBufferView | null>(array: T) => T;
          crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {if (array instanceof Uint32Array && array.length === 1) {array[0] = 1701; return array;} return original(array);};
        });
      }
      const key = ['rejected', 'inactive'].includes(identity) ? 'a' : identity;
      if (identity === 'rejected') backend.raw.members.find(m => m.id === ids.a)!.status = 'rejected';
      if (identity === 'inactive') backend.raw.members.find(m => m.id === ids.a)!.active = false;
      let user = {id: ids[key], email: `${key}@example.invalid`, email_confirmed_at: NOW, is_anonymous: false, aud: 'authenticated', role: 'authenticated', created_at: NOW, app_metadata: {provider: 'google', providers: ['google']}, user_metadata: {full_name: `Engineer ${key.toUpperCase()}`}};
      const tokenFor = (id: string) => [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({sub: id, exp: 4102444800, role: 'authenticated'})).toString('base64url'), 'synthetic'].join('.');
      const token = tokenFor(user.id);
      const origin=backend.runtimeOrigin??new URL(baseURL!).origin;
      const storageKey=resolveEnvironment(backend.url,origin).storageKey;
      await target.addInitScript(({user, token, signedOut, storageKey, oauthReturn}) => {
        localStorage.clear();
        if (oauthReturn) localStorage.setItem(storageKey+'-code-verifier',JSON.stringify('synthetic-verifier'));
        if (!signedOut && !oauthReturn) localStorage.setItem(storageKey, JSON.stringify({access_token: token, refresh_token: 'synthetic-only', expires_at: 4102444800, expires_in: 3600, token_type: 'bearer', user}));
      }, {user, token, signedOut: identity === 'signed-out',storageKey,oauthReturn});
      await target.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/config') {await backend.configGate; return route.fulfill({json: {url: backend.url, key: 'sb_publishable_synthetic_only'}});}
        if (url.origin === backend.url) {
          if (url.pathname === '/auth/v1/settings') return route.fulfill({json: {external: {google: backend.googleEnabled}}});
          if (url.pathname === '/auth/v1/authorize') {
            backend.oauthRequests.push(url);
            return route.fulfill({contentType: 'text/html', body: '<h1>Synthetic OAuth handoff</h1>'});
          }
          if (url.pathname === '/auth/v1/user') {await backend.authGate; return backend.authFailure ? route.fulfill({status:401,json:{message:'Synthetic session expired',code:'bad_jwt'}}) : route.fulfill({json: user});}
          if (url.pathname === '/auth/v1/token' && ((url.searchParams.get('grant_type')==='password' && backend.url.startsWith('http://127.0.0.1:')) || (url.searchParams.get('grant_type')==='pkce' && backend.googleEnabled))) {
            if (url.searchParams.get('grant_type')==='password' || identity==='signed-out') user={...user,id:ids.admin,email:'admin@duty.local'};
            return route.fulfill({json:{access_token:tokenFor(user.id),refresh_token:'synthetic-only',expires_at:4102444800,expires_in:3600,token_type:'bearer',user}});
          }
          if (url.pathname === '/auth/v1/logout') return route.fulfill({status: 204});
          if (url.pathname.startsWith('/rest/v1/rpc/')) {
            if (url.pathname.endsWith('/duty_load')) await backend.loadGate;
            try {return await route.fulfill({json: backend.rpc(url.pathname.split('/').at(-1)!, route.request().postDataJSON() ?? {}, user.id)});}
            catch (error) {
              const message = (error as Error).message;
              if (!message.startsWith('Synthetic stale')) errors.push(message);
              return route.fulfill({status: 409, json: {message, code: '40001'}});
            }
          }
        }
        if (backend.runtimeOrigin && url.origin===backend.runtimeOrigin) return route.fulfill({response:await route.fetch({url:baseURL+url.pathname+url.search})});
        if (url.origin === new URL(baseURL!).origin) return route.continue();
        unexpected.push(url.origin + url.pathname);
        return route.abort('blockedbyclient');
      });
      await target.goto((backend.runtimeOrigin??'/')+(oauthReturn?'?code=synthetic-oauth-code':''));
      if (waitForReady) await expect(target.getByRole('button', {name: identity === 'signed-out' ? backend.url.startsWith('http:')?'Sign in locally':'Continue with Google' : 'Sign out', exact: true})).toBeVisible();
      if (waitForReady && canManage(backend.raw, user.id)) await expect(target.locator('.workspace-controls')).toBeEnabled();
      return target;
    });
    // Finish intercepted responses before Playwright disposes the page/request context.
    await Promise.all([...attached].filter(target => !target.isClosed()).map(target => target.unrouteAll({behavior: 'wait'})));
    expect(errors, 'browser errors / unexpected RPC contract').toEqual([]);
    expect(unexpected, 'no external network access').toEqual([]);
  },
});
export {expect};
export const duty = (page: Page, day: string) => page.locator(`button[data-date="${day}"]`).filter({has: page.locator('.date-line')});
export async function keyboardRequest(page: Page) {
  await duty(page, '2026-11-02').focus(); await page.keyboard.press('Enter');
  await duty(page, '2026-11-03').focus(); await page.keyboard.press('Space');
  await expect(page.getByRole('dialog')).toBeVisible();
}
export async function confirmRequest(page: Page) {
  await page.getByRole('button', {name: 'Confirm Request', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}
export async function drag(page: Page, touch = false, fromDay = '2026-11-02', toDay = '2026-11-03') {
  const from = duty(page, fromDay), to = duty(page, toDay);
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!, b = (await to.boundingBox())!;
  const x = a.x + a.width / 2, y = a.y + a.height / 2, tx = b.x + b.width / 2, ty = b.y + b.height / 2;
  if (touch) {
    await touchEvent(page, 'touchstart', x, y); await page.waitForTimeout(400);
    await touchEvent(page, 'touchmove', tx, ty); await touchEvent(page, 'touchend', tx, ty);
  } else {
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(tx, ty, {steps: 8}); await page.mouse.up();
  }
  await expect(page.getByRole('dialog')).toBeVisible();
}
export async function touchEvent(page: Page, type: string, x: number, y: number) {
  await page.evaluate(({type, x, y}) => {
    const target = document.elementFromPoint(x, y)!;
    const touch = new Touch({identifier: 1, target, clientX: x, clientY: y});
    target.dispatchEvent(new TouchEvent(type, {bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch], changedTouches: [touch]}));
  }, {type, x, y});
}

export async function monthAction(page: Page, name: string) {
  const menu = page.getByRole('button', {name: 'Month actions', exact: true});
  if (await menu.isVisible()) {
    await menu.click();
    await page.getByRole('menuitem', {name, exact: true}).click();
  } else {
    await page.getByRole('button', {name, exact: true}).click();
  }
}
