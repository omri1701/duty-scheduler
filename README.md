# Duty — team rota

Milestone 1: a mobile-first, bilingual English/Hebrew scheduling demo for one engineering team. The initial October 2026 draft has 12 fictional engineers. Alex Morgan is both the manager and a participating engineer.

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

The application uses React and TypeScript with the supplied Vinext/Vite runtime and Radix components. `lib/rota/engine.ts` is a pure scheduling module independent of the UI or database; `tests/engine.test.mjs` exercises its rules; `tests/gesture.test.mjs` simulates quick taps, scrolling, long presses, desktop drags and cancellation. Sites build and hosting configuration is included for the private review demo. No Supabase credentials or production team data are required at this stage.

## Working features

- Editable monthly draft, regeneration, locked assignments and local demo publication.
- Primary-engineer swaps by desktop drag or long-touch drag, plus a keyboard-accessible picker. Every drop opens a review; locks are respected and availability conflicts require an explicit override. Emergency cover stays on its original duty block.
- One primary engineer per duty and an optional emergency second engineer.
- Batch availability and preferences: tap multiple dates, use an explicit date range, or hold and drag across consecutive days. Add an optional note to the selected dates, then save. The manager can edit every demo person.
- Team membership activation and seniority order using arrows; admin participates normally.
- Manual special blocks: inclusive first/last duty dates, ending 09:00 after the final day. Total fairness points = 1 base point + selected extra points.
- Local browser saving and JSON backup export.
- Seven-column monthly grids on mobile and desktop, English/Hebrew RTL switching.

## Scheduling rules and defaults

- Every calendar date is covered, including holidays. No automatic holiday exceptions.
- Standard duty: 09:00 to next-day 09:00 in Asia/Jerusalem. Dates are local calendar dates, not 24-hour UTC arithmetic; calendar feed conversion will apply DST when implemented.
- Weekend: Friday 09:00 through Sunday 09:00, one block and one fairness point. Friday and Saturday must both be available.
- Special blocks replace the normal blocks they touch, can cross a month boundary, and have 0–20 extra points with up to 14 days in the demo. The same engineer covers the whole block. These UI limits are demo defaults.
- Duty identity and accounting belong to the starting month. A block carried into the following month is displayed there but must be edited in its starting month. If the earlier month has not been scheduled, the block remains open until that month is generated.
- The second engineer receives the same points and is retained across regeneration.
- Seniority is a soft weight from 1.00 (most senior) to 1.12 (newest), not a promise of a fixed extra assignment. No tenure dates are stored.
- Historical fairness carries forward as deviation from the weighted share of each prior generated month. Participation in a historical month is inferred from assignments for this demo; new members do not inherit a duty debt for months before they joined. Explicit membership snapshots should replace this inference in the database milestone.
- The seeded multi-start heuristic first addresses duties with few available candidates and high points, randomizes equally constrained duty order, then balances weighted load and penalizes short gaps while lightly rewarding preferences. The UI supplies a fresh cryptographic random seed on each generation, mixed with the month. A small near-optimal candidate pool and a penalty for retaining the current arrangement create variety without relaxing hard constraints; deterministic seeds remain available for reproducible tests. It is not a proof of the mathematically optimal schedule. Unavailable primary assignments are never created automatically; a manager can explicitly override them.
- Consecutive duties are allowed when required and surfaced for review. Locked assignments are preserved, even when they have an explicit availability override.
- Special-block edits clear overlapping assignments; review/regenerate before publishing. Editing an assignment crossing months also returns the affected month to draft.

## Demo boundary / next milestone

Browser storage is device-local demo state, not a shared team database. There is no real authentication, employee permission enforcement, push delivery, calendar subscription, or swap service. Publication changes demo status only and does not notify anyone. The selected constraint deadline is recorded; admins can still edit after it.

Next: Google sign-in plus manager approval, Supabase with row-level access controls and membership snapshots, draft/published history, approved swaps, PWA/Web Push with scheduled delivery, personal revocable calendar feed URLs, and backup restoration. On iOS web push requires adding the app to the Home Screen and granting permission.

No external AI service is involved in scheduling. A read-only `read_duty_month` WebMCP tool is registered when the browser supports it; ordinary browsers do not need it. Real-device browser QA and WebMCP execution were not performed under this task's preview permissions. Scheduling, batch updates, swap rules and native gesture event handling are covered by 26 automated checks; type checking and the production build are additional validation gates.
