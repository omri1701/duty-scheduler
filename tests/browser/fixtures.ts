import {test as base, expect, type Page} from '@playwright/test';
import {addDays, blocks} from '../../lib/rota/engine';
import {canManage, type Snapshot, type DutyRow, type SwapRequest} from '../../lib/supabase/snapshot';

export const NOW = '2026-10-09T10:00:00Z', MONTH = '2026-11';
export const ids = Object.fromEntries(['admin', 'a', 'b', 'c', 'd', 'e', 'pending'].map((key, i) => [key, `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
const pub = '20000000-0000-4000-8000-000000000010';
export type Identity = 'admin' | 'a' | 'b' | 'c' | 'd' | 'e' | 'pending' | 'signed-out' | 'rejected' | 'inactive';
type Call = {name: string; params: Record<string, unknown>; user: string};

export function seed(): Snapshot {
  const members = Object.entries(ids).map(([key, id], i) => ({id, name: ['Avery Admin', 'Alex Atlas', 'Blair Birch', 'Casey Cedar', 'Drew Dale', 'Eden Elm', 'Pat Pending'][i], email: `${key}@example.invalid`, role: key === 'admin' ? 'admin' : 'engineer', status: key === 'pending' ? 'pending' : 'approved', active: true, seniority: i, color: ['#adc9ee', '#f0ba95', '#c9b1de', '#9bcfbe', '#eacb96', '#b6c8d1', '#adc9ee'][i]}));
  // Fixed rows independent of the generator: snapshots catch renderer changes too.
  const duties: DutyRow[] = blocks(MONTH, [{id: 'holiday', title: 'Holiday coverage', start: '2026-11-12', end: '2026-11-13', extra: 2}, {id: 'weekend-holiday', title: 'Weekend holiday', start: '2026-11-20', end: '2026-11-22', extra: 2}]).map((b, i) => ({
    id: `duty-${i}`, publication_id: pub, day: b.start, end_day: b.end,
    primary_id: members[i % 6].id, secondary_id: b.start === '2026-11-02' ? ids.c : null,
    manager_override: false, title: b.title ?? '', extra_points: b.title ? 2 : 0, points: b.points,
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
  raw = seed();
  calls: Call[] = [];
  invalidated = false;
  failNextSave = false;
  googleEnabled = false;
  oauthRequests: URL[] = [];
  snapshot(user: string) {
    const raw = structuredClone(this.raw), admin = canManage(raw, user);
    const member = raw.members.find(m => m.id === user)!;
    if (member.status !== 'approved' || !member.active) return {...raw, revision: null, members: [member], months: [], constraints: [], assignments: [], publications: [], swapRequests: []};
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
    if (name === 'duty_join') return null;
    if (name === 'duty_load') return this.snapshot(user);
    expect(p.p_revision).toBe(this.raw.revision);
    const admin = canManage(this.raw, user);
    if (name === 'duty_save_schedule') {
      expect(admin).toBe(true);
      if (this.failNextSave) {this.failNextSave = false; throw Error('Synthetic stale revision. Refresh and try again.');}
      const state = p.p_state as {duties: Omit<DutyRow, 'id' | 'publication_id' | 'points'>[]; months: Record<string, {deadline: string; status: 'draft' | 'published'; generated: boolean}>};
      this.raw.assignments = this.raw.assignments.filter(d => d.publication_id !== null);
      this.raw.assignments.push(...state.duties.map((d, i) => ({...d, id: `saved-${i}`, publication_id: null, points: (d.end_day === addDays(d.day, 2) ? 1 : [5, 6].includes(new Date(d.day + 'T12:00Z').getUTCDay()) ? .5 : 1) + d.extra_points})));
      for (const [month, value] of Object.entries(state.months)) {
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
    } else if (name === 'duty_review_member') {
      expect(admin).toBe(true);
      this.raw.members.find(m => m.id === p.p_member)!.status = p.p_status as string;
    } else if (name === 'duty_restore_publication') {
      expect(admin).toBe(true);
      const publication = this.raw.publications.find(v => v.id === p.p_publication)!;
      this.raw.assignments = this.raw.assignments.filter(d => d.publication_id !== null);
      this.raw.assignments.push(...this.raw.assignments.filter(d => d.publication_id === publication.id).map(d => ({...d, id: d.id + '-restored', publication_id: null})));
      this.raw.months.find(m => m.month === publication.month)!.status = 'draft';
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
  publish(month: string, rows = this.raw.assignments.filter(d => d.publication_id === null)) {
    const m = this.raw.months.find(m => m.month === month)!;
    const id = `publication-${++m.publication_sequence}`;
    this.raw.publications.push({id, month, version: m.publication_sequence, published_at: NOW, published_by: ids.admin});
    this.raw.assignments.push(...rows.map(d => ({...d, id: `${id}-${d.day}`, publication_id: id})));
    m.current_publication_id = id;
    return id;
  }
}

type Fixtures = {backend: Backend; openApp: (identity?: Identity, page?: Page) => Promise<Page>};
export const test = base.extend<Fixtures>({
  backend: async ({}, provide) => {await provide(new Backend());},
  openApp: async ({page, backend, baseURL}, provide) => {
    const attached = new Set<Page>(), errors: string[] = [], unexpected: string[] = [];
    await provide(async (identity = 'admin', target = page) => {
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
      const user = {id: ids[key], email: `${key}@example.invalid`, aud: 'authenticated', role: 'authenticated', created_at: NOW, app_metadata: {provider: 'google', providers: ['google']}, user_metadata: {full_name: `Engineer ${key.toUpperCase()}`}};
      const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({sub: user.id, exp: 4102444800, role: 'authenticated'})).toString('base64url'), 'synthetic'].join('.');
      await target.addInitScript(({user, token, signedOut}) => {
        localStorage.clear();
        if (!signedOut) localStorage.setItem('sb-baseline-auth-token', JSON.stringify({access_token: token, refresh_token: 'synthetic-only', expires_at: 4102444800, expires_in: 3600, token_type: 'bearer', user}));
      }, {user, token, signedOut: identity === 'signed-out'});
      await target.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/config') return route.fulfill({json: {url: 'https://baseline.supabase.co', key: 'sb_publishable_synthetic_only'}});
        if (url.origin === 'https://baseline.supabase.co') {
          if (url.pathname === '/auth/v1/settings') return route.fulfill({json: {external: {google: backend.googleEnabled}}});
          if (url.pathname === '/auth/v1/authorize') {
            backend.oauthRequests.push(url);
            return route.fulfill({contentType: 'text/html', body: '<h1>Synthetic OAuth handoff</h1>'});
          }
          if (url.pathname === '/auth/v1/user') return route.fulfill({json: user});
          if (url.pathname === '/auth/v1/logout') return route.fulfill({status: 204});
          if (url.pathname.startsWith('/rest/v1/rpc/')) {
            try {return await route.fulfill({json: backend.rpc(url.pathname.split('/').at(-1)!, route.request().postDataJSON() ?? {}, user.id)});}
            catch (error) {
              const message = (error as Error).message;
              if (!message.startsWith('Synthetic stale')) errors.push(message);
              return route.fulfill({status: 409, json: {message, code: '40001'}});
            }
          }
        }
        if (url.origin === new URL(baseURL!).origin) return route.continue();
        unexpected.push(url.origin + url.pathname);
        return route.abort('blockedbyclient');
      });
      await target.goto('/');
      await expect(target.getByRole('button', {name: identity === 'signed-out' ? 'Continue with Google' : 'Sign out', exact: true})).toBeVisible();
      return target;
    });
    expect(errors, 'browser errors / unexpected RPC contract').toEqual([]);
    expect(unexpected, 'no external network access').toEqual([]);
  },
});
export {expect};
export const duty = (page: Page, day: string) => page.locator(`button[data-gesture-key="${day}"]`).filter({has: page.locator('.date-line')});
export async function keyboardRequest(page: Page) {
  await duty(page, '2026-11-02').focus(); await page.keyboard.press('Enter');
  await duty(page, '2026-11-03').focus(); await page.keyboard.press('Space');
  await expect(page.getByRole('dialog')).toBeVisible();
}
export async function confirmRequest(page: Page) {
  await page.getByRole('button', {name: 'Confirm Request', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}
export async function drag(page: Page, touch = false) {
  const from = duty(page, '2026-11-02'), to = duty(page, '2026-11-03');
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
