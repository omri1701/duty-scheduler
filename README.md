# MiKo

MiKo (formerly Duty Scheduler) is a mobile-first, bilingual English/Hebrew duty scheduler for one engineering team. Milestone 2 connects Supabase storage, Google sign-in, manager approval, private constraints and published schedules. Hosted workspaces start empty. Engineers join through approved accounts or are added by an admin as temporary members without accounts. LOCAL provides isolated synthetic accounts. No assignments are generated until the manager confirms the monthly allocation and runs Generate.

For Codex and Claude Code setup, selective agent routing and CI gates, see [AI development](docs/AI_DEVELOPMENT.md).
For database-first deployments, approved Production releases, environment secrets
and recovery, see [CI/CD release workflow](docs/DEPLOYMENT.md).

## Run locally

Requires Node 22.13+ (Node 24 recommended) and the pnpm version declared in package.json.

```sh
pnpm install
pnpm start:local # Docker / Supabase CLI, current branch migrations + test accounts; phone link via ngrok
pnpm start:dev   # Frankfurt Development, http://localhost:5173; phone link via ngrok
pnpm start:prod  # explicit confirmation each run; application read-only inspection, PC only
```

`pnpm start:dev` is the Development default. Stop the server before switching targets;
an occupied port 5173 now fails before LOCAL setup or any readiness check, so
the launcher cannot accidentally validate an older server using another target.
no command rewrites `.env.local`. See [local targets and setup](docs/SUPABASE_SETUP.md#localhost-environment-selector)
for one-time keys, Docker setup, test accounts and Production login. Sessions are
isolated by actual project URL and local port.

Scheduling tests use Node 24's built-in TypeScript stripping:

```sh
node --test tests/*.test.mjs
pnpm exec tsc --noEmit
pnpm build
```

The application uses native Next.js 16 App Router, React 19, TypeScript and Radix components. `lib/rota/engine.ts` is a pure scheduling module independent of the UI or database; `tests/engine.test.mjs` exercises its rules; `tests/gesture.test.mjs` simulates quick taps, scrolling, long presses, desktop drags and cancellation. See [Supabase setup](docs/SUPABASE_SETUP.md) for Google configuration and first-admin onboarding, and [database architecture](supabase/README.md) for canonical schema files, clean migrations and real database validation.

## Temporary members

Admins can use **Team → Add temporary**, enter only a name,
and repeat for each engineer. Temporary members are approved active engineers in
the existing team, labeled **Temporary**, with no email or sign-in account. Admins
rename them from the member sheet, reorder seniority with the existing drag/arrow-key controls,
and toggle **Active** (in the sheet, or with a swipe on the row). Use **Availability → Engineer** to enter their constraints
and private notes, then select November and **Generate month** to review the
allocation and **Confirm & generate**. Accepted generation saves automatically;
reload to verify it before separately publishing.

Deactivate test engineers individually in the team list before planning. Keep an
active admin account. Inactive members receive no new automatic allocations;
existing assignments, constraints, IDs and compensation history remain. Existing
assignments involving inactive members require manager review before publication.
Temporary engineers participate in the same fairness and compensation rules as
regular engineers. Account linking is not available; do not create replacement
members or rename them to an email as a linking workaround.

For an unmerged branch, use `pnpm start:local` and the local admin account described
in [Supabase setup](docs/SUPABASE_SETUP.md#temporary-members-local-development).
`pnpm start:dev` uses hosted Development, which needs the reviewed database-first release
before these new RPCs are available.

## Native Next.js runtime and Vercel deployment

Copy `.env.example` to `.env.local` and set `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_...`). Next.js loads these server
variables; `/api/config` exposes only the existing public client configuration at
request time with `Cache-Control: no-store`, including configuration errors.
No `NEXT_PUBLIC_` prefix, service-role key or Google secret is needed. The browser
retains Supabase PKCE, local session persistence and direct RLS-protected RPC calls.

`useTeamWorkspace` keeps its public API while `lib/supabase/session.ts` observes
and verifies auth separately from `lib/supabase/workspace.ts` data operations.
Workspace requests and save locks belong to one identity; stale completions cannot
restore data after sign-out. Refreshes during a save share its final reload, and
mutations use the last accepted snapshot revision through the typed checked RPC
surface in `lib/supabase/rpc.ts`. Snapshot validation/conversion remains pure;
synthetic Node regressions cover session, refresh/save and failed-recovery races.
Startup shares one server-backed user verification across restoration events and
overlaps it with an RLS-protected read using the same captured token. The snapshot
stays unpublished until verification succeeds for the current identity. Existing
members (including pending/inactive accounts) skip registration; missing profiles
use the checked join RPC and reload. Focus/visibility events share revalidation
and refresh work; visible tabs still poll workspace data every 30 seconds.

While initial access or a changed identity is being verified, a public calendar
skeleton reuses the header, month selector, navigation styling, date-cell traversal
and responsive calendar CSS. Lightweight date helpers resolve the next Israel
calendar month at hydration, including leading/trailing dates, four-to-six week
rows and ordinary combined Friday/Saturday cells. Static HTML reserves an undated
grid until the browser date is known, so a cached build cannot show stale dates.
The shell uses no member, role or schedule data; disabled controls are inert and
hidden from assistive technology, with a separate loading status. Verification
failure returns to the access screen; only approved active members mount the real
workspace. The access screen (sign-in, waiting, declined, inactive) is one centred column
inside the safe areas: the logo, the name and "Your team's duty rota" over the brand glow,
then one main button with everything else as quieter text below it. Its corner switch
(English / עברית) works before sign-in, survives the Google round trip and becomes the
member's language. The phone keyboard scrolls the form into view rather than re-centring
it. Language stays consistent through account changes. There is no minimum
loading time or shimmer. Only placeholder content pulses on a smooth two-second
cycle; Reduce Motion disables that pulse and the brief calendar opacity transition.
Both screens use the same calendar surface (panel, toolbar, weekday row, grid
and footer), day-cell, assignment-chip, filter, date-line, header, footer and
month-heading components. Loading and interactive navigation share the pill,
indicator, tab definitions and styles; the loading version has no gesture handlers
or Radix controls. Inner geometry regressions enforce this shared structure.

Before verification, the shell has no manager-only actions. Unknown publication
status, private split weekends/special blocks, assignment text and team size can
change the verified layout. Existing role-specific layouts remain intact; the
public shell cannot predict those differences. Geometry regressions compare
individual controls, rows, cells, date spans and assignment chips in both roles
and languages at six widths, including padding, borders and weekend spans.
They assert absolute grid placement for ordinary engineer calendars and require
manager offsets to equal the measured space added by verified controls. Full
private-fixture captures retain absolute bounds and full-page screenshots so
role-dependent offsets and private-content changes remain visible. These checks
do not promise identical total page height before team size and private data are known.

`pnpm start:dev` and `pnpm start` use port 5173 to retain the localhost OAuth redirect.
`pnpm build` creates the standard `.next` output; `pnpm start` serves it with Node.
The build also verifies the emitted stylesheets linked by the generated page,
rejecting missing assets or CSS that lacks the responsive workspace styles.
Turbopack filesystem transform caching is disabled for development and production: DEV served byte-identical
pre-PR #22 CSS after receiving the updated source and restoring Vercel's build
cache, and a long-running localhost server later served old CSS with current
toolbar JSX. Restarting that server corrected its output without a layout edit.
Tailwind 4.2.1 can retain an old compiler AST when a save changes the file between
Next reading its input and Tailwind sampling its mtime. This was reproduced with
two inputs and an unchanged sampled mtime. Framework directives/theme utilities
now live in `app/tailwind.css`; custom application rules in `app/globals.css` bypass
that compiler cache. The source fingerprint runs **before** compilation, so a
cached AST also retains its old fingerprint instead of claiming newer input. The
development launcher checks downloaded CSS against the source before reporting
readiness, and the production build checks the linked output. Dependency caching
retains its defaults. Mobile readiness waits for a cold application/CSS compile
instead of treating a five-second timeout as a broken server. A CSS fingerprint
failure requires stopping/restarting the
server before validation; adding layout overrides cannot repair stale assets.
For a different production port, use `pnpm exec next start --port 3000`.

The repository is ready to import into Vercel using its **Next.js** framework
preset, Node 24, `pnpm build` and the default install/output settings. Set
`ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel uses the exact pnpm version in
`package.json`; see [Vercel build configuration](https://vercel.com/docs/builds/configure-a-build#corepack).
Configure the two application server variables separately: Production uses the
Frankfurt Production Supabase project; Preview and Development use an independent
Frankfurt Development project. Keep `.env.local` on Development and never pull
Vercel Production variables into it. Feature branches can use this same localhost
configuration; unmerged schema changes are tested on disposable local Supabase.
[Intentional manual previews](docs/DEPLOYMENT.md#feature-branches-localhost-and-intentional-previews)
use Development only after their required schema is deployed. Follow [the deployment runbook](docs/DEPLOYMENT.md) for the
approval-gated `develop` to `master` transition, environment scopes and rollback.
It needs no Workers adapter. Preserve production OAuth settings; configure the
development origin and exact trailing-slash redirect independently using
[Supabase setup](docs/SUPABASE_SETUP.md). Configuration is read at request time.

## Interface

The redesign (decision 2026-11-06) is Apple-clean: one token set in light and dark
(`app/globals.css`; **Auto / Light / Dark** per device in Settings, resolved before the
first paint by `lib/theme/theme.ts`), the system font, soft cards, and a small design system
in `components/ui` (Card, Sheet, ListRow, Chip, Avatar, Segmented, Switch, EmptyState,
Skeleton, CountUp, SwipeRow, Toaster). The product name lives in `lib/brand.ts`; the logo is one file, `public/brand/logo.svg`
(the company owl, traced from its PNG), drawn only by `components/brand/logo.tsx` (the name is plain text in the app font);
`scripts/render-icons.mjs` renders the favicon, PWA icons and iOS
startup screens from it. The brand colours are the logo's: navy `#090442` fills (white text on it)
and cyan `#19f2f7`, used only on navy or dark surfaces or as a glow, never as text or thin lines on
white (`--brand`, `--brand-fg`, `--cyan`). In dark mode navy fills get a thin near-white edge and a soft
cyan glow (`--brand-edge`). The Hebrew UI calls a duty כוננות (plural כוננויות) and the person on
duty כונן/ית; `tests/hebrew-terms.test.mjs` keeps the older word out. Member colours come from the 20-colour palette in
`lib/theme/palette.ts` (the 15 older stored values map onto it); each member picks their own
in Settings (`duty_set_color`, own row, taken colours greyed) and an admin can change anyone's
in the member sheet.

The month changes by direct manipulation, and the month name and the calendar swipe
separately. Dragging the calendar sideways moves it with the finger while the neighbouring
month, drawn by the same calendar component from the already-loaded snapshot, slides in
blurred and sharpens; past 40% of the width or a flick it lands, otherwise it springs back.
The name stays put and arrives blurred to sharp on release. While the neighbour shows, the
calendar eases to the taller month, so a six-week month is seen whole and nothing jumps when
it lands. Dragging the month name (on every month screen) moves only the name: the next
name follows the finger and sharpens as it arrives. Past 48px or a flick the month changes,
and the calendar (or the Availability grid) refreshes in place, blurred to sharp, with no
slide. The chevrons slide the calendar and roll the name. Hebrew mirrors all of it, and
reduced motion makes it instant. The landed month is the peek without the blur. Refreshes
keep the grid mounted and fade in only the chips whose person changed. Safe areas go through `--sat/--sab/--sal/--sar` (`env()` with a 0
fallback; `data-safe-area=test` forces iPhone insets in specs); the status bar style stays
`default` so its text is readable in both themes, and `theme-color` follows the chosen theme.

Four tabs: **Home · Schedule · Availability · Team**. Phones show a floating glass tab bar
(tap, or slide a finger along it); PC shows a sidebar. The header holds the activity bell
(publications, new versions, swap answers, sign-ups; a badge counts what is new since the
last look) and the avatar, which opens Settings. Sheets are bottom sheets on phones (swipe
down closes) and side panels on PC; Settings is a full page on phones (edge swipe or Back
closes). All motion respects Reduce Motion. On the first sign-in on a device three welcome
cards appear once. The service worker (`public/sw.js`) caches the app shell and the member's
last snapshot stays on the device, so the schedule is viewable offline with an **Offline**
pill and every write disabled.

**Home** greets the member and shows the next duties as cards ("Today", "Tomorrow", or
"In 4 days" with the date; type, points, cover; swipe for the following ones; **Ask to swap**
starts the swap in Schedule), then only what needs them: constraints due (→ Availability),
swap requests to answer with Accept / Decline (Approve / Reject for admins) inline, their
balance, and for admins a short to-do (members to approve, swaps to approve, a draft to
publish). **Schedule** is the calendar only: names in member colours, the member's own duties
ringed, today marked, a holiday tinted; the week runs left to right on PC even in Hebrew and
mirrors on phones. On a phone a tap on a day shows its duty under the grid and a tap on that
opens the duty sheet; on PC the tap opens the sheet directly. The sheet shows the facts and
**Swap** (then the calendar greys the days the server would refuse, with the reason) and, for
admins, **Edit**. Hold-and-drag still proposes a swap, swiping the calendar changes the month
with a slide, and Escape cancels a pick. Admins get one state-driven primary action
(**Plan the month → Review plan / Publish → Reopen**) and a ⋯ menu (Plan the month, Versions,
Constraints deadline, Special block, Clear board, Cancel draft); a reopened month adds a
Draft / Published switch. **Availability** is the grid with a due chip and, for admins, the
member picker. **Team** shows this month's coverage, the ordered team (hold the grip to
reorder, Up/Down on the keyboard), points and the live net balance; a tap opens the member
sheet (points, balance, and for admins role, No weekends, Active and colour), a swipe on a
row reveals Deactivate / Activate (works with a mouse too; a long swipe triggers it), and
deactivated members slide into a collapsed Inactive group. Join requests stay in Team.
**Plan the month** keeps the pie and the − / + counters, larger and animated. **Settings**:
profile, Appearance (theme, colour), Language, Notifications (switches and the reminder
wheels), Calendar, Export backup for admins, Sign out.

## Browser and visual regression baseline

The old toolbar and filter rules are gone with the redesign; `tests/browser/redesign.spec.ts`
captures every screen in both languages and themes for the review gallery, which opens a
viewer stepping through all captures (← →, Esc).
Managers reopen a published month to edit a draft. Special block, Clear board and Cancel draft
live in the ⋯ menu of a draft. Cancel Draft requires confirmation and atomically deletes the
working draft, returning to the current publication without creating a version or copying
working rows.
Before the month starts, Plan the month can change a reopened published month's points:
it plans from the ledger without that month's own debts, and publishing replaces them
(audited corrections, then the new plan). A deleted or re-planned month counts as nothing
(decision 2026-11-07): when a later published month repays one of its debts, that repayment
is released and its planned work becomes a debt the other way (the repaid member owes the
one who does it), shown in Team nets at once and repaid by a later plan as an ordinary debt.
Deleting or re-planning that later month reverses it too.
Managers use direct swaps in Draft. In Published, Edit in the duty sheet (or Enter on a
duty starting today or later) opens Edit duty for admins. Its "Swap with another duty…" button, then a tap on the second duty, proposes a swap
between any two members; dragging one duty onto another (long-press on a phone) proposes it directly.
Engineers keep the request workflow for their own duties.
Schedule and Constraints share the same visible Sunday–Saturday rows. When the
first is Saturday, both omit the entire first row and start on Sunday the 2nd.
Both halves of a weekend belong to Friday's month, which includes the cross-month
Saturday, editable as part of either a combined or split weekend. Constraints can
select it individually or in a range and save its actual date; existing date-based
publication/deadline checks still apply. All other adjacent-month dates retain
their assignments in faded, read-only cells. Editing or generating the owning
month does not reopen the adjacent month.
Availability and duty editors use the same Sheet (a bottom sheet on phones, a panel on PC).
Outside clicks, Escape, a swipe down and Close discard unsaved edits; pending saves block
dismissal. Focus returns to the calendar.
Availability notes appear in the editor and accessible date labels; only dates
with notes have a tiny corner dot. One fixed line shows the unique selected-day count during selection and editing (and
nothing when idle), with no calendar movement.
The modal title shows the actual localized date or chronological date range.
Range edits apply to every selected date. Replacing conflicting availability or
notes requires explicit confirmation; a blank shared description warns that old
notes will be cleared. Removing notes also requires confirmation. Canceling the
confirmation keeps the editor and existing data; confirmed replacement uses the
existing atomic RPC. Single-date editing prefills existing descriptions.
The floating glass navigation supports tapping and horizontal finger sliding across its four tabs.
The pill has 44px tab targets and 5px inner padding, with 16px outer margins where safe areas allow. Both sides use the larger horizontal
inset to preserve symmetry. Only the non-interactive background padding may
extend into the bottom safe area; tab targets stay entirely above it. A 34px
bottom inset therefore gives a 29px physical pill gap, rather than 16px. The
browser's dynamic safe-area values apply in Safari and standalone mode; no
device-specific offset or cached viewport height is used. Loading uses the same
geometry with disabled controls and no pointer targets.
Horizontal intent captures the pointer and retains the original grab position,
including far above/below the pill. Indicator movement is written once per frame
without rendering the workspace. A non-passive touch guard prevents native
panning only after horizontal intent; vertical-first scrolling stays native.
Release settles to the nearest track; cancellation, lost pill capture, Escape,
blur, resize or unmount restore the current selection. Reduced Motion disables
settling animation and haptics. Chromium native-touch tests and iPhone WebKit
emulation exercise the interaction; actual-device fluidity still needs review.
Combined weekends show both dates in their daily columns, with one assignment.
Team reordering starts only from its handle on touch and mouse. The lifted row
stays horizontally aligned, follows vertical movement, and moves neighbors at
measured row midpoints, including unequal row heights and gaps. Dragging above
or below the list targets the first or last row even with sideways movement.
Near a visible vertical edge, gentle auto-scrolling keeps the row attached to the finger and updates the insertion position. Release settles
and saves once. The dropped order stays visible until the server snapshot confirms
it; a newer external revision takes precedence. Failed saves return smoothly to
the latest confirmed order and show an error. Reordering is locked until the save
and reconciliation finish; profile details stay synchronized during that wait.
Phone handles center 25px dots and the inline rank across the full row in a 44px touch target.
Escape, touch/pointer cancellation or loss of the gesture
restores the original stack. Arrow keys retain accessible seniority reordering.
Feedback uses a feature-detected 8ms vibration, throttled to one per 80ms with
no queue, on supporting browsers. iPhone Safari gets visual selection/lift/drop
feedback only. Reduce Motion disables motion and vibration. No hardware
vibration or real iPhone keyboard/touch behavior has been verified by automation.
Tablet and desktop keep their existing navigation and other dialogs. Phone layout
regressions cover 320, 375, 390 and 430px, plus unchanged 768 and 1440px layouts;
actual Safari keyboard, safe areas and touch behavior still need device review.

Behavior-preserving migrations and refactors must pass this baseline against the
production build without changing the reference screenshots to conceal differences.
The Phase 1 reference screenshots from PR #4 remain unchanged through the native
Next.js migration and codebase cleanup. The lint baseline is empty; both
`pnpm lint` and the CI lint regression gate enforce the enabled rules.

```sh
pnpm test:unit
pnpm exec tsc --noEmit
node scripts/lint-regressions.mjs
pnpm build
pnpm test:e2e:ci
```

`test:e2e:ci` requires Docker and uses the pinned Playwright 1.63.0 Ubuntu Noble
image (including Chromium and fonts). It starts a native Next.js production server on port 8787,
reuses the build and installed dependencies, and stops the preview afterwards.
Quality CI runs this same command with two workers per runner, a single retry, pnpm
caching and failure traces/reports. Checks are tiered by the PR diff:

- PRs always run unit tests, `tsc`, lint and the build. Mapped UI/library changes
  add only their browser specs plus `baseline` and `visual`, run through the same eight
  duration-balanced browser shards (shards with no selected tests pass at once).
- PRs touching `supabase/**`, `lib/supabase/**` or SQL also run the disposable
  database job in parallel (about 5 minutes).
- Unknown or global paths (package/lockfile, configs, `app/globals.css`, shared
  shells, UI primitives, test fixtures, workflows, `scripts/**`) run everything.
- Pushes to `develop`/`master` and manual runs always run everything: the browser
  and visual suite as eight duration-balanced shards (scripts/browser-shard.mjs, weights in tests/browser/shard-weights.json) merged into one report, plus the database job
  (about 6 minutes). This full run gates Development deployment and releases.

The selector (`scripts/quality-scope.mjs`) runs from the PR's base commit, so a PR
cannot narrow its own checks. Strict documentation/AI-only PRs validate
instructions and SQL policy without an app/DB suite. The required `quality` check
fails if any selected job failed or any unselected job did not skip. Each runner
has its own browser report directories; there is no second browser install.
Production releases are manual and reuse trusted exact-SHA Quality evidence;
see [deployment approval and recovery](docs/DEPLOYMENT.md).
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

Coverage includes Node regressions for engine rules, snapshot conversion,
gesture state transitions and published swap eligibility, plus the runtime
configuration regression. Playwright promotes the
former optional swap browser script into supported tests and adds access/approval
states, disabled Google provider and synthetic PKCE handoff, month navigation,
empty generation, draft editing/publication, constraints,
history restore/deletion confirmation, split-weekend edits, keyboard dialogs,
desktop drag and simulated mobile long press, published
swap consent/decline/cancel/admin review, admin proposals and admin-as-party swaps,
availability alerts at request, consent and approval, changed-counterpart consent, invalidation,
Hebrew and RTL, profile reopening, availability reset when editing closes, and
team pointer/touch reorder announcements. Visuals
cover access, pending approval, admin draft, duty editor, history, engineer
publication, availability, swap confirmation/requests, availability alerts and the admin
proposal/approval summary, including desktop/mobile
English and Hebrew calendars, phone availability sheets and Team. Responsive
cases check both roles and languages across six widths; touch-only cases skip
desktop. Linux and Windows keep separate visual references.
Behavior assertions use roles/labels; date keys identify gesture targets because
their accessible names change with assignment and language.

`responsive-css.spec.ts` checks loaded CSS/JS assets, the phone tab bar and the PC sidebar,
and seven-column calendar geometry at 1440, 390 and 320px in English and Hebrew RTL. It
retains captures without updating visual references. `month-bar.spec.ts` verifies the CSS source
fingerprint and the month bar (one primary action, the ⋯ menu, centering and touch heights) at
desktop and iPhone WebKit widths in both languages, and the ⋯ menu under Chromium tab zoom
(100/150/200%) in New/Published/Reopened states and RTL.
For the real LOCAL app with Auth/PostgREST and no backend interception, use
`pnpm test:runtime:local` after `pnpm start:local`; see [the LOCAL verification
procedure](docs/SUPABASE_SETUP.md#unmerged-migrations-in-local-development).
To smoke-test an accessible deployed DEV build with the same
synthetic accounts and intercepted backend (no real member data or writes):

```sh
DUTY_E2E_URL=https://duty-scheduler-dev.vercel.app pnpm exec playwright test responsive-css.spec.ts --project=desktop
```

A Vercel sign-in redirect fails this check; protected deployments require
authorized access before their assets can be verified.
The environment-indicator tests simulate deployed hostnames while loading local
assets; their success does not verify a hosted deployment.

### Automatic visual review and approved snapshot updates

Every authorized UI change includes the relevant screenshot checks automatically.
The normal Playwright reporters generate `work/visual-review/index.html` and
`manifest.json` when running tests; keep the custom reporter enabled when filtering
tests. The gallery groups BEFORE/AFTER/DIFFERENCE and opacity overlays by project,
viewport, language and platform. It lists exact reference paths, source/head
commits and before/candidate SHA-256 hashes, including missing references and
differences from retries. Immutable run folders preserve earlier review evidence
when subsequent focused checks run. Pixel differences do not establish intent: the primary
agent inspects every candidate, explains changed components and possible regressions,
and fixes unintended changes before asking for approval.

Quality uploads the portable `visual-review` artifact even when comparisons fail
and links it in the run summary (full runs merge the shard galleries first). Download/extract it and open `index.html`.
The primary agent automatically adds the current artifact link and assessment to
the authorized PR description (or one concise authorized comment); a local gallery
is the fallback. CI remains read-only and never posts with elevated PR credentials.

**The user must explicitly approve the presented images/paths before any reference
is changed.** Earlier design approval does not approve changed candidates. After
approval, verify current reference/candidate hashes against the review manifest,
copy only the approved candidates to the approved paths, record approval scope and
hashes in the PR, and rerun affected comparisons and final Quality. Do not use a
blanket snapshot update to change unapproved references. Reuse completed checks
for unchanged inputs; never loosen screenshot tolerances or infer approval from CI.

After approval and successful validation, automatically remove task-created local
galleries, comparisons, recordings, manifests and reports; audit accidentally
tracked temporary artifacts. Record approval scope/hashes in the PR first.
Preserve user/unrelated files, test/reproducibility inputs, permanent review
scripts, CI integration and approved references. GitHub Actions artifacts expire
through their retention policy; do not delete them manually.

```sh
# Focused canonical review (does not update references):
pnpm test:e2e:ci visual.spec.ts
# Native Windows review with its own reference set:
pnpm test:e2e visual.spec.ts
# Final full comparison after copying only explicitly approved candidates:
pnpm test:e2e:ci
pnpm test:e2e:report
```

Review and commit the affected PNGs in `tests/browser/snapshots` with the reason
for each change. Keep the pinned image and Playwright version in sync. The native
Next.js server uses the original fixtures and reference images. The preview
launcher runs native Next.js; OAuth error assertions are scoped to the main region
to distinguish app alerts from Next.js's hidden accessibility route announcer.
`DUTY_E2E_URL` can select an already-running local production preview, for
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
  dismissing dialogs in English/Hebrew. Both editors restore focus to their
  calendar button after dismissal. Their main Save action fills the footer;
  destructive confirmations retain Cancel. Dialogs fade without scaling editable
  text, and phone/coarse-pointer controls use at least 16px (or larger user text
  settings). Browser font/transform/viewport checks do not prove native Safari
  focus zoom prevention; confirm keyboard opening/closing and manual pinch zoom
  on a real iPhone.
- Verify database permissions and atomic publication/swap/history rules only in an
  empty development project following [Supabase setup](docs/SUPABASE_SETUP.md).
  Browser RPC fakes verify client contracts and UI responses, not RLS, PostgreSQL
  transactions or concurrency enforcement. No hosted SQL tests were run here.

## Working features

- Shared monthly drafts, varied regeneration and manager-controlled publication, with real team accounts only.
- Google sign-in with pending membership approval, multiple participating admins, engineer-specific constraints and server-enforced deadlines.
- Atomic saves with stale-revision checks, private admin drafts and preserved published schedules during edits.
- Published duty swap requests: approved members drag their primary duty starting today or later onto another engineer’s duty (or select two dates with tap or the keyboard). Eligibility uses the date in Asia/Jerusalem, including today after 09:00; a weekend starting yesterday remains ineligible. The current counterpart accepts or declines; only then can an admin approve or reject. Requesters can cancel while pending. Admins may also propose a swap between any two members (drag or select any two duties in Published): each member accepts or declines their own side, and only the proposing admin can cancel. When the admin is one of the two, their side is the request and only the other member is asked. Every swap, including one an admin proposed or takes part in, still ends with an explicit admin approval after both members accepted, because the admin first records it in an external system; the approval dialog shows a copyable English/Hebrew summary of who, which dates and the points moved. Admins can reject at any pending stage. While a swap is being chosen (a selected duty, the editor's swap button or a drag), every target day the server would refuse is greyed with a short reason in its tooltip and accessible name, and a tap, Enter or drop on it shows the reason instead of opening anything: “You can’t take 4 Nov” (the swap's own person is unavailable on that day), “Dana can’t take your day” (the other person is unavailable on the source day; an admin swapping two others reads both names), emergency cover's unavailability, a second weekend, or a day that has passed. The reasons come from `duty_swap_availability` (who and which date, never the note or type), so usable days stay green. Before sending, the dialog still checks both members' unavailability and names whose constraint blocks which date (never the note); a blocked swap cannot be sent. Accepting rechecks it (a party may still accept, then the admin must override with a reason), and so does final approval. Approval creates a new published version from the current publication, preserving drafts, history, emergency cover and date points; the copied plan's targets follow a weighted swap, so a reopened month republishes unchanged. Pending requests retain their original duty slots across versions; counterpart changes clear consent and require both members to answer again. Loss of requester ownership, or a republish that changes either duty's points, invalidates the request. The approval dialog always shows the latest copy of the request, so its summary never describes a stale pairing. Temporary members have no account, so an admin answers their side ("Answer for Tamar (Temporary)") and then still approves separately; deactivating a party invalidates their pending swaps, so no request waits on someone who cannot sign in.
- Published duty edit (admins, months without an open draft): change one published duty's engineer and extra points without a swap, for example when someone can't make it and another engineer covers. The engineer picker names each unavailable date (with its note) and needs an explicit admin override with an audit reason. **Temporary** (default) makes the old engineer owe the new one the duty's published points, including extra already on it, repaid in later months by the normal plan rules; **Permanent** records no debt for anyone: the engineer being replaced, whoever holds the duty now (also after a swap or an earlier edit), gives it away for good, and earlier swaps and Temporary edits keep their own balances. Giving the duty back to someone who held it before a Temporary change still in effect undoes that change instead, so its debt cancels; Edit duty says so. Deleting the edited version (Versions) undoes it exactly. A split weekend whose two halves end up on the same person (same cover and lock) is saved as one ordinary Friday–Sunday duty again, so swaps and weekend rules see one weekend; identical halves saved earlier heal on the next edit of either. Extra added in the edit counts for whoever does the duty; half points stay exact. Before saving, the admin reviews a copyable EN/HE summary (dates, old → new engineer, points and extra, Temporary/Permanent, who owes whom, any override reason; never availability notes) for their external record. Publishing creates a new version through `duty_edit_published_duty`; earlier versions, drafts and emergency cover are unchanged and the Team net shows the new debt. Edit duty names a pending swap of that duty before saving, and saving cancels it; a reopened edited month republishes unchanged; an editor left open while another tab publishes says so and must be reopened.
- Foreign-key lookup tables for roles, membership statuses, month statuses and constraint types. Duty dates and extra points share the assignment table; changing an engineer preserves points.
- Multiple admins, self-edited display names and deactivation without losing history. The first login is pending until explicitly promoted.
- Published version history with calendar previews, restore-to-draft and confirmed deletion. Deleting a month’s only version removes every debt it booked (uneven credit and Temporary changes), so with no version left every Team net is zero; its kept draft books them again when published. Points already worked or settled by hand stay booked; a later month's repayment of the deleted month's debts becomes a debt the other way (see Plan the month). Each version keeps duty rows with real member foreign keys. Publish removes the month's working rows; Reopen copies the selected publication into a separate mutable draft. Cancel removes that draft completely, including specials, weekend splits, emergency cover and overrides, while keeping history and independent availability/deadline/team/request data.
- Desktop drag or long-touch drag swaps primary engineers with a review before applying. Emergency cover stays on its dates. Availability conflicts and increased weekend counts above one require explicit manager approval in the draft swap dialog, which lists each affected engineer and resulting weekend count. One confirmation can approve both exceptions; approved assignments retain override metadata. Published swap requests keep their existing consent and approval rules.
- Manual weekend editor (draft months): tapping a combined weekend opens one sheet with a **One weekend | Two days** switch. One weekend has one person, one lock and one emergency cover; Two days splits it, in the same sheet, into two day cards that each edit like a regular day (its date and points, person, lock, emergency cover) and start with the weekend's person and lock. Switching back joins at once when both days have the same person; otherwise **Keep X / Keep Y** shows the points each choice moves, and the kept person's lock carries over. Both days save atomically; identical person, emergency cover and lock join into one Friday–Sunday duty. In the calendar a split weekend is two regular day chips; tapping a half opens that day's editor with **Part of a split weekend · Join**. Its range labels Friday–Saturday, including cross-month weekends; the duty still ends Sunday at 09:00. Plan the month notes how many unlocked split weekends Generate will join back into one weekend (**Show** points at them); lock a half to keep its split.
- Edit Duty has a small Lock/Unlock toggle beside Close. Save commits the lock with the chosen primary; closing without Save discards both edits. The weekend toggle applies to both saved primaries. Locked draft cells show a lock icon, and their primaries survive reloads and repeated regeneration. Unlock and Save to allow reassignment. Generate has no separate lock/exception panel; conflicting locks must be corrected or unlocked in the calendar, and existing exact exception approvals remain scoped to their original assignments.
- Clear board (admins, draft view only, in the ⋯ menu; its red confirm button rests at full strength everywhere) removes every unlocked assignment the month owns, for a fresh start. It confirms first ("Clear N unlocked duties? Locked duties stay."), saves through the same revision-checked schedule save, and keeps locked duties, constraints, special/holiday dates, the Plan the month targets, other months and published versions. The month goes back to Generate month. The success toast offers Undo for 10 seconds, which puts back only duties that are still empty; leaving the month or its draft withdraws the offer. It is hidden on a published month and on the Published view of a reopened draft, and disabled, with the reason as its tooltip, when nothing is left to clear or while Generate runs.
- Availability popup with unavailable/preferred choices, optional description, and a one-action removal. Tap one day or hold and drag for a consecutive range. Closing with X, Escape, or an outside tap clears the selection; the removal action appears only when selected dates have a saved constraint or note. Descriptions appear on calendar dates.
- Drag team members to set seniority (senior first, newest last). Keyboard users can focus a drag handle and use Up/Down. Monthly and all-month point counters remain visible on phones.
- Team net balance: each Team row shows the compensation balance projected from published schedules (positive: owed relief; negative: owes work; half points allowed), and Home shows the member's own. Published temporary transfers and scheduled repayments count immediately; working drafts never do. Admins see every row; engineers see only their own. Hover, tap or focus the number (or open the member sheet) for one line per open relationship (counterpart, points and source, including the half point owed for an uneven monthly split; a lone half point that no whole duty can repay says it is waiting for the second half). Half-point debts are never rounded, forgiven or expired, and they net across people: if A owes B half a point and C owes A half a point, C owes B and A is clear. It refreshes with every published change; the internal ledger still settles only worked duties.
- Settings (the avatar; a full page on phones, a panel on PC): display name, Appearance (Auto / Light / Dark per device, the member's own colour), language (the only language switch in the signed-in app; the sign-in and waiting screens keep their own), notifications, Calendar (subscribe to my calendar), Export backup for admins and Sign out. The language is saved on the member (`duty_set_language`, own row only, no workspace revision) in the background whenever it changes, and becomes the default on sign-in and on a new device.
- Web push notifications (install MiKo as a Home Screen app; iPhone needs iOS 16.4+ and the Home Screen app, Android works in Chrome): *Enable notifications* asks for permission, subscribes this device with the server's VAPID key and registers it (`duty_save_push_subscription`, known push services only, up to ten devices each). Each member switches kinds on or off and sets reminder times (Israel time): constraint deadline (10:00 three days before to everyone; 10:00 the day before only to members with no constraints for that month), a month published, swap requests (only the people involved; admins when it waits for approval), an admin changing your published duty, the evening before your duty (18:00) and the morning of it (08:30), and, for admins, a new member waiting. Texts are in the member's language and carry only dates, never notes or swap explanations; each opens its tab and month. The database records each notification once (unique key), Event alerts are handed to pg_net when their change commits; Supabase pg_cron runs `duty_private.push_tick()` every 15 minutes for deadlines and reminders (reminder times are quarter hours), and pg_net posts due deliveries to the protected `/api/push/dispatch`, which signs them with VAPID. `pnpm push:setup local|dev|prod` sets it up. Signing out forgets this device. See [web push setup](docs/SUPABASE_SETUP.md#web-push-notifications).
- Distinct pastel engineer colors with contrasting text, compact dates, and no repeated duty times. Seven-column calendars, English/Hebrew RTL, local saving, JSON backup export, and an editable monthly constraint deadline.

## Scheduling rules and defaults

Application Generate uses the [allocation planner](docs/ALLOCATION_PLANNER.md),
[HiGHS scheduling engine](docs/GENERATION_ENGINE.md) and
[checked database boundary](docs/ALLOCATION_DATABASE.md). The authoritative
[generation specification](docs/GENERATE_ALGORITHM.md) defines the rules.

- Generate opens one allocation popup, ordered senior first. A large donut pie leads it: one slice per engineer, sized by points and coloured with the member colour, growing and shrinking smoothly as targets change (instantly under reduced motion). Its centre shows the configured/required total, or the details (points, temporary, permanent, locked) of the slice under the pointer, the tapped slice, or the engineer row in hover or keyboard focus; the pie also has a text label listing everyone's points. Each engineer card shows one number with − / + and, only when non-zero, chips for the temporary, permanent and locked parts (two columns on desktop, one on phones). Each engineer has one net Temporary and one net Permanent change; Points = fair share (plus repayment) + both, and locked duties count toward Points. One Temporary/Permanent switch sets which change every − / + edits (Temporary on every opening). Controls use one-point steps on every opening, with a 0.5 toggle, Undo and **Reset**. Reset replaces the plan with the one a first opening makes, with no hand edits, drags or kept baseline, so the automatic No weekends +1s follow the current settings (reopening still keeps hand edits). It asks first only when it would discard hand edits or drags, Undo brings the previous plan back, and it is unavailable, saying why when pressed, when the plan is already the starting one, can't be edited or generation has closed. Automatic counterparts are recomputed from scratch on every change across engineers the manager has not touched, so the result does not depend on click order; an edit whose counterpart no one can absorb is disabled, so the configured total always equals the month total, also after Save or Generate and reopening (the plan keeps which engineers were edited by hand). A permanent change never takes away more than the engineer's own share and never lifts fair share + Permanent above the month's total points (Permanent + is disabled at that ceiling), and points never go below locked. No one owes or is owed more than the month's points. Dragging one engineer onto another gives exactly one point as a temporary transfer; the brief notice offers Make permanent. Long-press (touch), right-click, Enter or Shift+F10 on an engineer opens the same "Give 1 point to…" list.
- Compensation is proposed before confirmation. Temporary changes record who carries work for whom; Permanent changes create no new compensation. Actual primary assignments fund repayment/transfer intent at publication. Planned future work is a projection, not completed repayment. Confirmed targets are never silently replaced by an achieved amount or refreshed proposal.
- Allocation planning, redistribution and scheduling run in cancellable Workers using lockfile-pinned, same-origin WASM at `/api/scheduling/asset/*`. Unsupported browsers show recovery instructions. Search budgets are 15 seconds for proposals, five for edits/checks and 30 for generation. Cancellation terminates synchronous WASM and retains saved assignments. A failed generation or save is never retried: the popup reads the month again at once and reviews the retained targets, and team data changing while it is open does the same. A saved allocation in an earlier format, or a failure that only a fresh proposal resolves (an ordinary baseline the duties cannot split into, or uneven-month credit), is replaced by a new proposal that keeps the per-person changes that still fit, with a short notice. **Save**, beside Confirm & generate, stores the whole plan (every Temporary and Permanent change, adjustments and locks) through the same checked confirmation without generating, so the manager can close the popup and continue later; it reads Saved until the next change. Confirm & generate saves before generating, and once coverage has started the main action is Save allocation and the separate Save is hidden. Only when the month cannot be read does the main action become Try again.
- Generate and Regenerate stop at the first owned duty's 09:00 Jerusalem handover, including Sunday opening for a Saturday-starting month. The popup, Worker acceptance and checked save enforce that cutoff. A fresh seed rearranges unlocked primaries; explicit locks and exact reasoned exceptions persist. Manual editing and swaps remain available under existing checks.
- Complete and partial drafts save through revision/fingerprint-checked RPCs. Partial output retains confirmed targets, actual/missing points and all uncovered dates; it cannot publish. Manual point changes require allocation review. Publish, reopen, restore and Cancel Draft retain the existing immutable-history and accounting boundaries.

- Every calendar date is covered, including holidays. Standard duty runs 09:00 to next-day 09:00 in Asia/Jerusalem. Dates are local calendar dates; a future calendar integration will apply timezone/DST conversion.
- A full weekend is Friday 09:00 through Sunday 09:00, worth one point. A split weekend is two independent 09:00–09:00 duties worth half a point each. Clearing both days of a weekend (Leave unassigned) keeps one empty weekend, never two empty halves. Either half counts as that engineer’s one primary weekend for the month; covering both halves is still one weekend. A hand split is a one-off edit: the next Generate fills an unlocked split weekend again as one Friday–Sunday weekend for one member (keeping Friday’s emergency cover, else Saturday’s). A split with a lock on either half stays split: the locked half keeps its person and Generate fills an unlocked half like any unlocked duty. A split never changes planning, locked or not: for fair shares, the plain split and uneven-month credit, the “can’t split evenly” note, Reset and re-plans, Plan the month (and the checked confirmation in the database) sees the weekend it came from, worth its halves’ sum. The split only decides who works each half; the ±0.5 between the two people is the change the admin types (Temporary or Permanent), Plan the month notes where the schedule differs from the plan (“3.5 scheduled, plan says 4”), and Save stores exactly the points typed. The check that Generate can make the targets exactly uses Generate’s own duties: an unlocked split as one weekend, a locked split as its two halves. Emergency cover earns zero primary points and consumes no primary weekend or spacing allowance; its existing identity and availability checks remain.
- Generation gives a primary engineer a second weekend in a month only as a last resort, when coverage and the confirmed targets need it, and then spreads the extra weekends as evenly as it can (two members with four weekends take two each). Locking a second weekend still needs an explicit manager approval. Existing emergency assignments are retained for manager review.
- Special ranges create independent daily duties on weekdays. Extra points are added **per date**: weekday 1 + extra, Friday 0.5 + extra, Saturday 0.5 + extra. A weekend touched by a range stays **one** Friday–Sunday holiday weekend worth the sum of its two dates (1 + extra on both dates = 3 at +1; a Friday-only holiday weekend is 2), which Generate gives to one member and never splits automatically. If a manager splits a holiday weekend by hand, each half keeps its own date's points, so splitting never changes the total. Weekend caps and “either half counts as the weekend” are unchanged. The calendar marks only the holiday dates, shows the extra once per duty top-right on the date line, and renders two or more adjacent duties of one member as a single level bar (one title, one total, continued across the Saturday→Sunday row break) with the name centred once in each calendar row of the bar; tapping a date still edits that date's duty. On a phone, a week with a lock or a +extra shows them on their own line under the dates, so they never cover a date. The demo supports 0–20 extra points and ranges up to 14 days. Removing extra points from a duty (combined or split) preserves its assignment, its shape and the remaining special dates. Adding a range on dates that already have duties keeps every assignment the same way: people, emergency cover, locks (the changed points of a locked duty are an explicit lock review) and the duties’ shape. Only the points change, and Plan the month shows the resulting difference between scheduled and planned points for the admin to act on.
- Weekend identity and point accounting belong to the month containing Friday, including a Saturday in the next month. Edit either half in Friday’s month. Other duties belong to their own date’s month. Prior-month carried coverage is preserved when generating a new month.
- Ordinary workload is approximately equal; seniority breaks equivalent choices in favor of newer engineers. Projected linked compensation is considered before confirming targets. Neighboring current publications and working drafts guard boundaries; generation never writes another owner month.
- Generation optimizes covered dates, marked special dates, missing target points, then the fewest extra weekends, the fewest back-to-back pairs, then the largest minimum gap between anyone's duties (back-to-back pairs are not gaps), then weekend rotation across months (turns, then no Thursday with a weekend in one month, then the weekend wave), weekday variety within the month (no weekday twice, then no weekday staircase), weekday rotation across months, preferred dates, a new weekend predecessor and seeded ties, in that order; the whole sorted gap list only breaks the remaining ties. Proof and completeness remain separate: UNKNOWN is not failure, and a search-limited verified result is labeled best found. Automatic duties never exceed targets, bypass availability or touch the same engineer's duty in a neighbouring month.
- Non-weekend members: an admin can tick **No weekends** on a member in **Team & fairness** (a standing setting, stored in the database and changed only through an admin-only checked RPC; everyone sees “No weekends” beside the role). Generate never places that member on a weekend duty, including holiday weekends and either half of a split weekend, and leaves them out of the weekend rotation. A weekend already locked to them is kept, with a short warning in Plan the month; unlock it in the calendar to free it. Manual calendar edits stay the admin's call, with a warning like an availability conflict: placing them on a weekend (either day, primary or emergency cover) in the duty editor, a draft swap or a published duty edit names them (“Eden doesn’t take weekends · 6 Nov”; the picker marks them “no weekends”) and needs **Approve these exceptions as manager** first. The approval is checked in the browser only; the database does not refuse such a weekend. Plan the month proposes **+1 Permanent** for them every month (no repayment), taken from the weekend members so the total stays the month total; the admin can still edit it that month, and the row notes “No weekends · +1”. Only weekend members fund it, never another No-weekends member, and never below what they need for the month's weekends (one each, heaviest first, as far as they go). When they can't fund every +1, as many get it as fit, starting one member further each month so each is left out equally often, and Plan the month says why (for example “Only Omer and Shira take weekends, so the No weekends +1 is left out for 8 members this month.”). The plan's exact-points check also keeps weekends on weekend members, so Generate can book every planned point. Turning the setting off rejoins the weekend rotation level with the team, like a new member, not due first: their duties from the months generated or published so far no longer count for the rotation. When one member or none still takes weekends, Plan the month says before Generate that weekends may stay empty.
- Weekend rotation: everyone gets a weekend before anyone gets a second one. Generate also avoids giving one person both a Thursday and a weekend (either half of a split weekend) in the same month, allowing it only when nothing else works; this ranks below the weekend turns and above the wave. Each round keeps the last round's order loosely, as a wave: a member's place moves at most two places, so with 12 weekend members their weekends are 10–14 weekends apart, and inside that band the order is random. A member blocked from their place takes the nearest free one and everyone else keeps theirs. Generate also avoids putting someone right after the same person as last round. The state is derived from published months only: either half of a split weekend is that member's turn, a member skipped for availability stays due and gets priority in later months, and a new or returning member takes no weekend in their first month, then joins the next cycle at a random place rather than first in line. Locked weekends count, emergency cover does not, and spacing still comes first.
- Weekday variety: for Sunday–Thursday duties, Generate avoids giving one person the same weekday twice in a month whenever that keeps the minimum gap, and prefers weekdays the person has not covered yet in the current weekday cycle, derived from published months like the weekend rotation (a cycle ends when everyone present has covered all five weekdays; a new or returning member joins level with the team). Beyond the minimum gap the exact spacing pattern is left to the seed, so consecutive months do not repeat the same two-week pattern, and no person steps a weekday forward (or back) twice in a row, such as Sunday, Monday, Tuesday over consecutive weeks: at most one such step each way per month, counting the neighbouring months' duties, and never at the cost of the minimum gap or a repeated weekday.
- Back-to-back automatic primary duties (including separate weekend halves) are a last resort: Generate uses them only when no schedule with fewer covers the month and meets the targets, so a member whose target exceeds what spaced days allow still gets it, and an ordinary month has none. A duty touching the same member's duty in a neighbouring month is a back-to-back day too: a last resort counted with the others (decision 2026-11-01); an overlap stays impossible, and a locked handover needs its approval. Locked back-to-back duties need a manager exception that names the exact fixed duties/dates/weekends with a reason; an approved pair costs nothing. Plan the month warns "Availability allows about N" only above a member's available days, and notes "This needs some back-to-back days" when a target fits availability only that way.
- After Generate, Plan the month is the review: the toolbar action becomes **Review plan** (with a dot while notes wait) and the plan notes per person "N scheduled, plan says M", the back-to-back days Generate needed, uncovered dates and an early search stop. The manager fixes differences with Temporary or Permanent and Save. When Publish is disabled, one line says why, with **Open plan**.
- Subscribe to my calendar (Settings → Calendar): an approved member creates a personal feed URL and adds it with one tap to Apple Calendar (`webcal://`) or Google Calendar (add by URL), or copies it. The feed holds only that member's own current published duties, primary and emergency cover, 92 days back to 400 days ahead: all-day events on the duty's Israel dates (a weekend spans Friday–Saturday, each half of a split weekend is its own event) in a calendar named “MiKo · My duties”, titled “Duty”, “Weekend duty (Friday)”, “Emergency cover” or the special block's title, with the points when they differ from the usual and the 09:00 handover in the description, in the member's language (it follows every language change, `duty_set_language`), with a link back to the app. Never other people's duties, names, availability or notes. Event UIDs follow the member, date and role, so swaps, edits and new publications update events in place and removed duties disappear. The URL's 64-character token is the only credential (calendar apps cannot sign in); the database stores only its SHA-256 hash, **Reset link** (with a confirm) replaces it at once, and an inactive or declined member's feed returns 404. This device remembers the link so it can be copied again; signing out forgets it. Google can take a few hours to refresh a subscription.
- Assignment edits require an open draft. Special-weight changes preserve confirmed numbers for review. Structure changes touching emergency cover require separate review, and the database refuses silent changes to locked work. The existing Special Block editor remains owner-scoped; cross-owner edits require separate reviewed drafts.

## Current boundary / next milestone

The workspace uses Supabase. The demo route and browser-local fallback have been removed; fictional fixtures remain in automated tests and isolated development environments only. Production is reserved for approved users and real schedules. The first signed-in account needs explicit admin approval. Live hosting and Google OAuth settings must be verified separately; repository tests do not prove real sign-in. See [the deployment runbook](docs/DEPLOYMENT.md).

Next: full action audit logs and backup restoration.

No external AI service is involved in scheduling. A read-only `read_duty_month` WebMCP tool is registered when the browser supports it; ordinary browsers do not need it. Real-device browser QA and WebMCP execution were not performed under this task's preview permissions. Scheduling, batch updates, swap rules and native gesture event handling are covered by automated regression checks; type checking and the production build are additional validation gates.
