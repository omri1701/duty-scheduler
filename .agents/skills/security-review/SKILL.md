---
name: security-review
description: "Review Duty auth, RLS, RPC, permissions, private-data handling, migrations or CI trust-boundary changes; skip cosmetic edits."
---

# Security review

1. Start with the diff and relevant trust boundary. For database/auth changes read
   `docs/SUPABASE_SETUP.md` permissions and only affected migrations/RPC callers.
   Trace the real server-side check; UI checks and snapshot tests are insufficient.
2. Check anonymous, pending, inactive, approved engineer and admin access where
   relevant. Test ownership/private notes, role escalation, last-admin protection,
   immutable publications, revision races and deadline enforcement only as affected.
3. Inspect RLS/grants and privileged functions together: caller identity, explicit
   authorization, safe search_path and execute permissions. Reject authorization
   based on user-editable metadata or client-supplied roles/IDs alone. Do not expose
   secret/service-role keys or loosen policies to resolve an error.
4. For CI changes check token permissions, untrusted PR execution, action pinning,
   secret exposure and any deploy/write steps. Never run untrusted PR code with
   elevated credentials through pull_request_target.
5. Use synthetic fixtures and an explicitly identified empty development database
   for `supabase/tests/access.sql`; never connect to live data to validate a review.
   If unavailable, report database authorization as untested. Do not replay applied
   migrations on a shared project or perform an audit of unrelated schema.
6. Return actionable findings with severity, file/line, prerequisites, impact and
   a regression suggestion. Separate confirmed issues from hypotheses and scope
   limitations. Do not edit or delegate during a review; the primary agent owns fixes.
