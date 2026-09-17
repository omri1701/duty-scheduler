# Duty — team rota

A mobile-first, bilingual English/Hebrew duty scheduler for one engineering team. Milestone 2 connects Supabase storage, Google sign-in, manager approval, private constraints and published schedules. The separate `/demo` route retains the fictional 12-engineer example and device-local storage.

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

The application uses React and TypeScript with the supplied Vinext/Vite runtime and Radix components. `lib/rota/engine.ts` is a pure scheduling module independent of the UI or database; `tests/engine.test.mjs` exercises its rules; `tests/gesture.test.mjs` simulates quick taps, scrolling, long presses, desktop drags and cancellation. Sites build and hosting configuration is included for the private review demo. The demo needs no credentials. See [Supabase setup](docs/SUPABASE_SETUP.md) for the live workspace, Google provider configuration and the manager reservation.

## Working features

- Shared monthly drafts, varied regeneration and manager-controlled publication, with a separate offline demo.
- Google sign-in with pending membership approval, one participating manager, engineer-specific constraints and server-enforced deadlines.
- Atomic saves with stale-revision checks, private manager drafts and preserved published schedules during edits.
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

The real workspace uses Supabase; `/demo` remains browser-local. Google credentials and the confirmed manager email still need configuration before real sign-in can be verified. The current Site is owner-private; team access requires sharing or a separately agreed hosting change.

Next: employee swap requests with approval, PWA/Web Push with scheduled delivery, personal revocable calendar feed URLs, audit history and backup restoration. Publication does not send notifications yet.

No external AI service is involved in scheduling. A read-only `read_duty_month` WebMCP tool is registered when the browser supports it; ordinary browsers do not need it. Real-device browser QA and WebMCP execution were not performed under this task's preview permissions. Scheduling, batch updates, swap rules and native gesture event handling are covered by automated regression checks; type checking and the production build are additional validation gates.
