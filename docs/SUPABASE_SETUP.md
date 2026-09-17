# Supabase setup

The live app uses the **Duty Scheduler** Supabase project (`ukxxpbivgxyxharhxgqf`). The database schema is installed; the Site runtime has its project URL and publishable key. Google OAuth and the manager email reservation must be completed before real sign-ins work. No fictional demo accounts or schedules are imported into the database.

## 1. Enable Google sign-in

Follow [Supabase's Google provider setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

In Google Cloud, configure the OAuth consent screen and create an OAuth client of type **Web application**:

- Authorized JavaScript origin: `https://duty-rota.keshet-mako-7367.chatgpt.site`
- Authorized redirect URI: `https://ukxxpbivgxyxharhxgqf.supabase.co/auth/v1/callback`
- Request only the normal sign-in scopes (openid, email, profile); calendar access is not needed.
- If the Google consent screen remains in Testing, add the manager and engineers as test users.

In Supabase → Authentication → Sign In / Providers → Google, enable Google and enter the OAuth client ID and client secret. Keep the secret in Supabase, never in this repository or chat.

In Supabase → Authentication → URL Configuration:

- Site URL: `https://duty-rota.keshet-mako-7367.chatgpt.site`
- Redirect URLs: `https://duty-rota.keshet-mako-7367.chatgpt.site/`
- For local development only, add the exact localhost origin/port used by `pnpm dev`.

The current Site remains owner-private. Team members also need access through Sites sharing, or the app must be hosted at a team-accessible URL. A hosting change requires updating Google origins and Supabase redirect URLs.

## 2. Reserve the manager's verified Google email

Confirm the actual manager email before executing this in Supabase SQL Editor; account ownership in ChatGPT is not used to infer it:

```sql
insert into duty_private.manager_identity (email)
values (lower('REPLACE_WITH_MANAGER_GOOGLE_EMAIL'));
```

This is a one-time reservation, not an invitation. The manager receives the role after signing in with that verified email. Everyone else starts pending. There can be only one manager, who is also an active engineer. If already waiting for approval when the email is reserved, reload the app or sign out and in again.

## 3. First team setup

1. Sign in as manager.
2. Let engineers sign in and approve them in **Team & fairness → Join requests**.
3. Drag the team into seniority order (senior first, newest last).
4. Set the month deadline, collect constraints, generate a draft, review and publish.
5. Engineers see only published assignments. When you reopen a draft, they keep seeing the previous publication until you publish again.

## Local development

The demo works at `/demo` without Supabase configuration. For the real workspace, create an ignored `.env.local`:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
```

The `/api/config` route exposes only these public client values. All database reads require a user session and row-level permissions. No service-role key is needed. The browser talks directly to Supabase with its own session.

## Migrations and verification

Migration source is under `supabase/migrations`. Files were created with the Supabase CLI and their version prefixes reconciled to the versions returned by the connected project's migration runner. Do not reapply them to the live project. For a separate development project, apply migrations in order using the Supabase CLI or SQL Editor.

`supabase/tests/access.sql` verifies permissions and publication rules with synthetic users inside a transaction that rolls back. It deliberately refuses to run after a real manager reservation exists; use a separate empty development project then. It sends no invitations or emails.

```sh
node --test tests/*.test.mjs
pnpm exec tsc --noEmit
pnpm build
```

## Permissions and persistence

- Pending/rejected/inactive users can see their own membership record only.
- Active approved engineers can read team profiles, month settings and published schedules; their own constraints stay visible only to themselves and the manager.
- Only the manager can approve members, reorder/activate engineers, change deadlines, edit or generate drafts, and publish.
- Client table writes are denied. Checked RPCs perform atomic changes and reject stale workspace revisions instead of silently overwriting another user's save.
- Deadline checks run on the database using the date in Asia/Jerusalem, including the deadline day. Published months close employee constraint edits; the manager can reopen them.
- The app refreshes on window focus and every 30 seconds while visible. Save errors remain visible and do not show a success message.
- Publications preserve the latest published snapshot per month, not an unlimited audit history. Managers continue editing separate draft rows.

The private manager reservation table intentionally has RLS with no client policy and no client table grants: this is deny-all, not a missing access rule. Supabase reports it as informational ([RLS with no policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)). Indexes on the empty project may also be reported as [unused](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index); retain the foreign-key/query indexes as team data grows.

Push notifications, personal calendar subscriptions, employee swap requests, backup restoration and audit history remain future work. Google sign-in must be checked end-to-end after credentials and the manager email are configured.
