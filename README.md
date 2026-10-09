# Duty — team rota

A mobile-first, bilingual English/Hebrew duty scheduler for one engineering team. Milestone 2 connects Supabase storage, Google sign-in, manager approval, private constraints and published schedules. The app starts empty and uses real, approved accounts only. No assignments are generated until the manager clicks Generate.

For Codex setup, selective agent routing and CI gates, see [AI development](docs/AI_DEVELOPMENT.md).

## Run locally

Requires Node 22.13+ (Node 24 recommended) and the pnpm version declared in package.json.

```sh
pnpm install
pnpm dev
```

Scheduling tests use Node 24's built-in TypeScript stripping:

```sh
node --test tests/*.test.mjs
pnpm exec tsc --noEmit
pnpm build
```

The application uses React and TypeScript with the supplied Vinext/Vite runtime and Radix components. `lib/rota/engine.ts` is a pure scheduling module independent of the UI or database; `tests/engine.test.mjs` exercises its rules; `tests/gesture.test.mjs` simulates quick taps, scrolling, long presses, desktop drags and cancellation. Sites build and hosting configuration is included for the private review demo. See [Supabase setup](docs/SUPABASE_SETUP.md) for the live workspace, Google provider configuration and the first admin promotion.

## Regression baseline before Next.js

Behavior-preserving migrations and refactors must pass this baseline against the
production build without changing the reference screenshots to conceal differences.
Phase 1 changes testing only; the application still runs on Vinext/Vite.

```sh
pnpm test:unit
pnpm exec tsc --noEmit
node scripts/lint-regressions.mjs
pnpm build
pnpm test:e2e:ci
```

`test:e2e:ci` requires Docker and uses the pinned Playwright 1.63.0 Ubuntu Noble
image (including Chromium and fonts). It starts the existing production preview,
reuses the build and installed dependencies, and stops the preview afterwards.
Quality CI runs this same command with two workers, a single retry, pnpm caching
and failure traces/reports. There is no second browser installation or build.
For native local debugging, run `pnpm exec playwright install chromium` once,
then `pnpm test:e2e` or `pnpm test:e2e --headed --project=desktop` after building.
Windows has separate reference images; Linux CI images are canonical. Other host
platforms can use Docker instead of creating another snapshot set.

The synthetic browser fixtures in `tests/browser/fixtures.ts` intercept configuration,
auth and RPC requests, block external requests, and use only `example.invalid`
identities. No `.env.local`, hosted records, Google credentials or database fixtures
are needed. Each test owns its backend; multi-account flows use separate browser
contexts. Unexpected RPCs, client revisions and browser errors fail the test.
The date is fixed at 9 October 2026, the initial calendar at November 2026, and
generation uses seed 1701. Locale, Israel time zone, light theme, reduced motion,
device scale and viewport (1440×1000 / 390×844) are fixed; screenshots wait for
fonts and disable animations/carets. The pinned container fixes font rendering.

Coverage reuses the 53 existing Node tests for engine rules, snapshot conversion,
gesture state transitions and published swap eligibility. Playwright promotes the
former optional swap browser script into supported tests and adds access/approval
states, disabled Google provider and synthetic PKCE handoff, month navigation,
empty generation, draft editing/publication, constraints,
history restore/deletion confirmation, split-weekend edits, keyboard dialogs,
desktop drag and simulated mobile long press, published
swap consent/decline/cancel/admin review, changed-counterpart consent, invalidation,
Hebrew and RTL. Visuals
cover access, pending approval, admin draft, duty editor, history, engineer
publication, availability and swap confirmation/requests, including desktop/mobile
English and Hebrew calendars. There are 48 browser cases (one intentionally skipped
desktop case for mobile-only touch) and 24 snapshots per operating system.
Behavior assertions use roles/labels; date keys identify gesture targets because
their accessible names change with assignment and language.

### Intentional snapshot updates and migration comparison

```sh
# Canonical Linux snapshots, only after reviewing an intentional UI change:
pnpm test:e2e:ci visual.spec.ts --update-snapshots
# Windows reference set when developing natively on Windows:
pnpm test:e2e:update
# Compare (does not update missing or mismatched snapshots):
pnpm test:e2e:ci
pnpm test:e2e:report
```

Review and commit the affected PNGs in `tests/browser/snapshots` with the reason
for each change. Keep the pinned image and Playwright version in sync. Before the
Next.js conversion, retain these fixtures, tests and images; update only the preview
launch adapter for the new runtime, then run the same suite against its production
build. `DUTY_E2E_URL` can select an already-running local production preview, for
example `http://host.docker.internal:3000` from Docker Desktop. Never point it at
a shared/live site. Inspect actual/expected/diff images and traces from the HTML
report or the `browser-baseline` CI artifact; classify differences before accepting
them. CI must compare committed images, never regenerate them automatically.

### Manual release checklist and limits

- On real iOS Safari and Android Chrome: tap versus scroll, long press, drag/drop,
  scroll during a drag, touch cancellation, availability range selection, pinch/zoom,
  keyboard opening and Hebrew RTL at narrow widths. Synthetic TouchEvents and
  Chromium mobile emulation do not prove real-device behavior.
- With explicitly authorized test accounts: real Google OAuth redirect/PKCE,
  denial, session expiry/refresh and sign-out, pending-to-approved onboarding, and
  two real sessions seeing persistence/stale-revision conflicts. CI never attempts
  real Google login or shared database writes.
- Check screen-reader announcements, contrast, zoom and keyboard focus after
  dismissing dialogs in English/Hebrew. Current duty editor does not restore focus
  to the calendar button on Escape; retain this known gap for a separate UI fix.
- Verify database permissions and atomic publication/swap/history rules only in an
  empty development project following [Supabase setup](docs/SUPABASE_SETUP.md).
  Browser RPC fakes verify client contracts and UI responses, not RLS, PostgreSQL
  transactions or concurrency enforcement. No hosted SQL tests were run here.

## Working features

- Shared monthly drafts, varied regeneration and manager-controlled publication, with real team accounts only.
- Google sign-in with pending membership approval, multiple participating admins, engineer-specific constraints and server-enforced deadlines.
- Atomic saves with stale-revision checks, private admin drafts and preserved published schedules during edits.
- Published duty swap requests: approved members drag their future primary duty onto another engineer’s duty (or select two dates with the keyboard). The current counterpart accepts or declines; only then can an admin approve or reject. Requesters can cancel while pending. Approval creates a new published version from the current publication, preserving drafts, history, emergency cover and date points. Pending requests retain their original duty slots across versions; counterpart changes clear consent and require the new owner to accept. Loss of requester ownership invalidates the request.
- Foreign-key lookup tables for roles, membership statuses, month statuses and constraint types. Duty dates and extra points share the assignment table; changing an engineer preserves points.
- Multiple admins, self-edited display names and deactivation without losing history. The first login is pending until explicitly promoted.
- Published version history with calendar previews, restore-to-draft and confirmed deletion. Each version keeps duty rows with real member foreign keys.
- Desktop drag or long-touch drag swaps primary engineers with a review before applying. Emergency cover stays on its dates; availability conflicts need an explicit manager override. Swaps cannot create a second weekend for an engineer.
- Manual weekend editor: separate Friday and Saturday engineer fields. Saturday follows Friday until explicitly changed; both days save atomically. Identical owners and emergency cover automatically recombine into a single Friday–Sunday cell.
- Availability popup with unavailable/preferred choices, optional description, and a one-action removal. Tap one day or hold and drag for a consecutive range. Closing with X, Escape, or an outside tap clears the selection; the removal action is prominently displayed. Descriptions appear on calendar dates.
- Drag team members to set seniority (senior first, newest last). Keyboard users can focus a drag handle and use Up/Down. Monthly and all-month point counters remain visible on phones.
- Distinct pastel engineer colors with contrasting text, compact dates, and no repeated duty times. Seven-column calendars, English/Hebrew RTL, local saving, JSON backup export, and an editable monthly constraint deadline.

## Scheduling rules and defaults

- Every calendar date is covered, including holidays. Standard duty runs 09:00 to next-day 09:00 in Asia/Jerusalem. Dates are local calendar dates; a future calendar integration will apply timezone/DST conversion.
- A full weekend is Friday 09:00 through Sunday 09:00, worth one point. A split weekend is two independent 09:00–09:00 duties worth half a point each. Either half counts as that engineer’s one weekend for the month; covering both halves is still one weekend. Emergency cover also counts toward the cap.
- Generation never assigns a primary engineer to more than one weekend in a month. If availability or team capacity prevents coverage, it leaves the duty open for a manager decision. Manual edits can explicitly approve a second-weekend exception. Existing emergency assignments are retained for manager review.
- Special ranges create independent daily duties. Extra points are added **per date**: weekday 1 + extra, Friday/Saturday 0.5 + extra. Weekend special dates retain the weekend cap and always display separately. The demo supports 0–20 extra points and ranges up to 14 days. Removing extra points from a date preserves its assignment and the remaining special dates.
- Weekend identity and point accounting belong to the month containing Friday, including a Saturday in the next month. Edit either half in Friday’s month. Other duties belong to their own date’s month. Prior-month carried coverage is preserved when generating a new month.
- Each month is balanced independently. Past-month points and gaps do not affect generation. All-month totals remain available for reference. Seniority is a soft weight from 1.00 (most senior) to 1.22 (newest), plus a small preference for giving the indivisible remainder to newer engineers. Availability, weekend capacity, and high-point special dates can require exceptions.
- Generation balances points and spacing, lightly rewards preferences, and explores randomized candidate schedules. Each generation uses a fresh cryptographic seed mixed with the month; deterministic seeds support regression tests. This is a heuristic, not a guarantee of the mathematically optimal schedule. Unavailable primary assignments are never created automatically.
- Consecutive duties are allowed when needed. Regeneration replaces manual primary assignments; there is no hidden assignment lock. Emergency second engineers receive the same points and are retained.
- Adding a special range clears affected assignments for review. Assignment edits return affected months to draft. Existing version-1 browser data migrates to daily special coverage, preserves notes and assignments, removes obsolete locks, and reopens drafts for review.

## Current boundary / next milestone

The workspace uses Supabase. The demo route and browser-local fallback have been removed; fictional fixtures remain only in automated tests. Google credentials still need configuration before real sign-in can be verified; the first signed-in account then needs explicit admin approval. The current Site is owner-private; team access requires sharing or a separately agreed hosting change.

Next: PWA/Web Push with scheduled delivery, personal revocable calendar feed URLs, full action audit logs and backup restoration. Publication does not send notifications yet.

No external AI service is involved in scheduling. A read-only `read_duty_month` WebMCP tool is registered when the browser supports it; ordinary browsers do not need it. Real-device browser QA and WebMCP execution were not performed under this task's preview permissions. Scheduling, batch updates, swap rules and native gesture event handling are covered by automated regression checks; type checking and the production build are additional validation gates.
