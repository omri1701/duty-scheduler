# Supabase setup

Project: **Duty Scheduler** (`ukxxpbivgxyxharhxgqf`). The Site runtime already has its public project URL and publishable key. No service-role key is used by the app. Google credentials must be configured before the first login.

## 1. Create the Google OAuth client

Follow [Supabase's current Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project, such as **Duty Scheduler**.
2. Open **Google Auth Platform** and configure the app branding/contact details. Choose an audience that allows the team's Google accounts. For a testing app, add your Google email under **Audience → Test users**; add teammates when ready.
3. Under **Data Access**, use only `openid`, `userinfo.email` and `userinfo.profile`.
4. Under **Clients**, create an OAuth client of type **Web application** with these exact values:

| Setting | Value |
|---|---|
| Authorized JavaScript origin | `https://duty-rota.keshet-mako-7367.chatgpt.site` |
| Authorized redirect URI | `https://ukxxpbivgxyxharhxgqf.supabase.co/auth/v1/callback` |

## 2. Configure Supabase

In **Authentication → Sign In / Providers → Google**, enable Google and enter the client ID and secret from Google Cloud. Enter the secret only in Supabase, never in this repository or chat.

In **Authentication → URL Configuration** set:

| Setting | Value |
|---|---|
| Site URL | `https://duty-rota.keshet-mako-7367.chatgpt.site` |
| Allowed redirect URL | `https://duty-rota.keshet-mako-7367.chatgpt.site/` |

## 3. First login and explicit admin promotion

After both dashboards are configured, open the app and choose **Continue with Google**. This Google account can be different from the ChatGPT account. Supabase creates the real login identity; the app creates a pending engineer profile using the Google display name. Nothing is generated or assigned automatically.

The first account is **not** automatically made admin. Identify and confirm its actual account ID/email, then use a trusted SQL connection to promote that exact row in `duty_members` and increment `duty_workspace.revision` in one transaction. There is no email reservation table. Reloading or **Check approval** then enters the workspace.

Approved admins can approve later join requests and change approved members' roles in **Team & fairness**. Multiple admins are supported, and at least one active approved admin must remain. Every admin can also receive duties. Approved people can change their own display name through their avatar; subsequent logins do not overwrite it.

The current Site is owner-private. Team members also need Sites access or an agreed team-accessible hosting URL. Changing hosting requires updating the Google origin and Supabase redirect URLs.

## Current database

| Table | Purpose |
|---|---|
| `auth.users` (Supabase-owned) | Verified login identities; not application-managed sample users. |
| `duty_members` | Profile, role FK, approval-status FK, active flag, seniority order and color. Deactivation retains history. |
| `duty_workspace` | One revision counter for atomic saves and stale-edit detection. |
| `duty_months` | Deadline, status FK, generated flag, current publication FK and monotonic version sequence. |
| `duty_constraints` | Engineer/date, constraint-type FK and a private note. |
| `duty_assignments` | Duty dates, primary/emergency member FKs, title, extra points, computed total points and publication FK. NULL publication means draft. |
| `duty_publications` | Version ID, month FK, sequence number, publisher FK and timestamp. |
| `duty_roles` | Engineer/admin definitions and the admin capability. |
| `duty_member_statuses` | Pending, approved and declined definitions. |
| `duty_month_statuses` | Draft and published definitions. |
| `duty_constraint_types` | Unavailable and preferred definitions. |

The former `manager_identity`, `duty_specials` and `duty_split_weekends` tables have been removed. Their old creation statements remain in historical migrations so the repository can reproduce the schema in order.

A regular duty spans one date; an intact weekend spans Friday through Sunday and is one stored row. Split or special weekend dates use separate rows in the same duty table. Extra points belong to the duty date and survive changing the assigned engineer. Selecting a special range in the UI sets those dates' extra points together.

Publishing creates a new immutable version and copies its duty rows, keeping actual foreign keys rather than a JSON snapshot. Admins can preview old versions in a seven-column calendar, restore one to a draft or delete one after confirmation. Restoring preserves the current publication until Publish is clicked; a boundary weekend may also reopen an adjacent month's draft. Deleting the live version selects the newest remaining version; deleting the last version unpublishes that month. Version numbers are not reused.

## Permissions and validation

- Pending/rejected/inactive accounts see only their own membership record and harmless lookup definitions.
- Approved active engineers see current published duties and their own constraints. Notes are visible only to that engineer and admins.
- Admins see drafts/history and manage approvals, roles, deactivation, deadlines, duties and publications.
- Client table writes are denied. Checked RPCs enforce permissions and lock/check the global revision. Profiles and roles have separate checked operations.
- Constraints use the deadline date in Asia/Jerusalem, inclusive of that day. Publication closes the month's engineer edits; admins can reopen a draft.
- Refresh runs on focus and every 30 seconds while the app is visible.

Migrations under `supabase/migrations` are already applied to the connected project. They were created with the Supabase CLI and reconciled to the remote migration version IDs. Apply them in order only to a separate new development project. The consolidation migration deliberately refuses to discard unexpected pre-existing schedule data.

`supabase/tests/access.sql` creates synthetic auth/member records inside one transaction and rolls everything back; it sends no email and refuses to run on a project with real members. Use an empty development project after real onboarding begins. Checks cover explicit first-admin promotion, multiple admins, last-admin protection, FK values, own-name edits, private notes, stale revisions, publication versions, stable points, boundary-weekend restores, deletion and deactivation.

The security advisor reports no findings. The fresh, empty database has informational [unused-index notices](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index); foreign-key indexes are retained for real usage.

```sh
node --test tests/*.test.mjs
pnpm exec tsc --noEmit
pnpm build
```

For local development, create an ignored `.env.local` with `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, and allow the actual localhost URL in the provider settings. The app has no demo login or local-data fallback.

Push notifications, calendar subscriptions, employee swap requests and full action audit logs remain future work. Real Google OAuth must be checked after provider setup; database role tests do not replace that check.
