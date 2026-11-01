// Fail closed: only known prose and validated AI instructions can skip app/DB checks.
// Quality runs this file from the PR BASE commit, so a PR cannot narrow its own checks;
// any change here (scripts/**) or to workflows, configs or fixtures selects every check.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function instructionOnly(event, files) {
  return event === 'pull_request' && files.length > 0 && files.every(instruction);
}

function instruction(file) {
  return ['README.md', 'AGENTS.md', 'CLAUDE.md', '.codex/config.toml', '.codex/agents/qa.toml', '.codex/agents/security.toml',
    '.claude/agents/qa.md', '.claude/agents/security.md'].includes(file)
    || /^docs\/[\w/-]+\.md$/.test(file)
    || /^\.(agents|claude)\/skills\/(scheduling-regression|code-change-validation|security-review|feature-delivery)\/SKILL\.md$/.test(file);
}

// Every selected PR browser run also covers the broad workflow and screenshot baselines.
export const SMOKE_SPECS = ['baseline', 'visual'];
const allocation = ['allocation', 'duty-locks', 'temporary-members'];
const calendar = ['calendar-controls', 'calendar-final-polish', 'interaction-polish', 'mobile-interactions', 'month-boundaries', 'month-navigation', 'swaps'];
const mobile = ['mobile-interactions', 'mobile-layout', 'mobile-navigation', 'month-navigation', 'calendar-final-polish'];
const editors = ['editor-dialogs', 'availability-polish', 'cleanup', 'duty-locks', 'mobile-layout'];
const team = ['team-optimistic', 'team-reorder', 'temporary-members', 'cleanup', 'final-polish'];
const startup = ['startup', 'startup-layout', 'startup-layout-capture', 'startup-performance-capture', 'environment', 'google-login'];

// Explicit source -> spec map (exact file, or directory ending in "/"). Anything unmapped,
// including shared shells (workspace.tsx, app/page.tsx), UI primitives and CSS, runs everything.
export const SPEC_MAP = {
  'app/api/scheduling/': allocation,
  'app/api/solver-spike/': ['solver-spike'],
  'app/solver-spike/': ['solver-spike'],
  'components/auth/': startup,
  'components/environment-indicator.tsx': ['environment', 'startup'],
  'components/rota/allocation-dialog.tsx': allocation,
  'components/rota/availability-editor.tsx': editors,
  'components/rota/calendar-presentation.tsx': calendar,
  'components/rota/duty-editor.tsx': editors,
  'components/rota/editor-dialog.tsx': editors,
  'components/rota/mobile-navigation.tsx': mobile,
  'components/rota/month-heading.tsx': calendar,
  'components/rota/navigation-presentation.tsx': mobile,
  'components/rota/profile-dialog.tsx': ['cleanup', 'final-polish'],
  'components/rota/publication-history.tsx': ['calendar-controls'],
  'components/rota/swap-requests.tsx': ['swaps', 'calendar-controls'],
  'components/rota/team-list.tsx': team,
  'components/rota/temporary-member-dialog.tsx': team,
  'components/rota/workspace-availability.tsx': editors,
  'components/rota/workspace-calendar.tsx': calendar,
  'components/rota/workspace-summary.tsx': ['calendar-controls', 'calendar-final-polish'],
  'components/rota/workspace-team.tsx': team,
  'components/rota/workspace-toolbar.tsx': ['toolbar-runtime', 'toolbar-zoom', 'calendar-final-polish', 'month-navigation'],
  'hooks/use-allocation-workflow.ts': allocation,
  'hooks/use-calendar-interactions.ts': calendar,
  'hooks/use-hold-drag.ts': [...calendar, 'mobile-layout'],
  'hooks/use-israel-today.ts': ['calendar-final-polish'],
  'hooks/use-mobile-layout.ts': mobile,
  'hooks/use-optimistic-team.ts': team,
  'lib/allocation/': allocation,
  'lib/compensation/': allocation,
  'lib/date-format.ts': calendar,
  'lib/rota/calendar-dates.ts': [...calendar, 'startup-layout', 'startup-layout-capture'],
  'lib/rota/drag-presentation.ts': calendar,
  'lib/rota/engine.ts': [...calendar, 'startup-layout'],
  'lib/rota/gesture.ts': [...calendar, ...mobile],
  'lib/scheduling/': allocation,
  'lib/solver-spike/': ['solver-spike'],
  'lib/supabase/': ['supabase-lifecycle', 'startup', 'environment', 'google-login', 'swaps', 'duty-locks', 'temporary-members'],
  'lib/tactile.ts': [...calendar, ...mobile],
};

const FULL = Object.freeze({application: true, database: true, browser: 'full', specs: []});
const SPEC = /^tests\/browser\/[\w-]+\.spec\.ts$/;
const database = file => /^(supabase|lib\/supabase)\//.test(file) || file.endsWith('.sql');
const mapped = file => Object.keys(SPEC_MAP).filter(key => key.endsWith('/') ? file.startsWith(key) : file === key);

// Returns which jobs run. Push, dispatch and unknown events always select every check.
export function selectChecks(event, files, exists = existsSync) {
  if (event !== 'pull_request' || files.length === 0) return FULL;
  if (instructionOnly(event, files)) return {application: false, database: false, browser: 'none', specs: []};
  const specs = new Set();
  let db = false;
  for (const file of files) {
    if (instruction(file) || /^tests\/[\w-]+\.test\.mjs$/.test(file)) continue; // Unit tests always run.
    if (database(file)) db = true;
    if (/^supabase\//.test(file)) continue; // SQL and its harnesses run in the database job.
    if (SPEC.test(file)) {
      if (!exists(file)) return FULL; // A deleted or renamed spec cannot be selected by name.
      specs.add(file);
      continue;
    }
    const keys = mapped(file);
    if (keys.length === 0) return FULL;
    for (const key of keys) for (const name of SPEC_MAP[key]) specs.add(`tests/browser/${name}.spec.ts`);
  }
  if (specs.size === 0) return {application: true, database: db, browser: 'none', specs: []};
  for (const name of SMOKE_SPECS) specs.add(`tests/browser/${name}.spec.ts`);
  const selected = [...specs].sort();
  assert(selected.every(spec => SPEC.test(spec)));
  return {application: true, database: db, browser: 'selected', specs: selected};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {GITHUB_EVENT_NAME: event, PR_BASE: base, GITHUB_OUTPUT: output} = process.env;
  let files = [];
  if (event === 'pull_request') {
    assert.match(base ?? '', /^[a-f0-9]{40}$/);
    const diff = spawnSync('git', ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD'], {encoding: 'utf8'});
    assert.equal(diff.status, 0, diff.stderr);
    files = diff.stdout.split('\0').filter(Boolean);
  }
  const checks = selectChecks(event, files);
  console.log(JSON.stringify(checks));
  await appendFile(output, `application=${checks.application}\ndatabase=${checks.database}\nbrowser=${checks.browser}\nspecs=${checks.specs.join(' ')}\n`);
}
