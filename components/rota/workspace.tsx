'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, Users, SlidersHorizontal, Info, Download, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { DutyEditor } from '@/components/rota/duty-editor';
import { ProfileDialog } from '@/components/rota/profile-dialog';
import { PublicationHistory } from '@/components/rota/publication-history';
import { SwapRequests } from '@/components/rota/swap-requests';
import { WorkspaceAvailability } from './workspace-availability';
import { WorkspaceToolbar } from './workspace-toolbar';
import { WorkspaceCalendar } from './workspace-calendar';
import { WorkspaceSummary } from './workspace-summary';
import { WorkspaceTeam } from './workspace-team';
import {
  DraftSwapDialog,
  SpecialDutyDialog,
  MonthSettingsDialog,
  PublishDialog,
  WorkspaceHelpDialog,
} from './workspace-dialogs';
import type { TeamWorkspace } from '@/hooks/use-team-workspace';
import { useWorkspaceDraft } from '@/hooks/use-workspace-draft';
import { useCalendarInteractions } from '@/hooks/use-calendar-interactions';
import { todayIsrael, fromSnapshot } from '@/lib/supabase/snapshot';
import { Toaster, toast } from 'sonner';
import { addDays, monthNext, blocks } from '@/lib/rota/engine';
import { calendarDates, workspaceMetrics } from '@/lib/rota/workspace-data';
export function RotaWorkspace({ remote }: { remote: TeamWorkspace }) {
  const isManager = remote.isAdmin,
    meId = remote.user!.id;
  const [month, setMonth] = useState(monthNext(todayIsrael().slice(0, 7))),
    [lang, setLang] = useState<'en' | 'he'>('en'),
    [tab, setTab] = useState('schedule');
  const state = remote.state!;
  const [profileOpen, setProfileOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false);
  const [help, setHelp] = useState(false),
    [settings, setSettings] = useState(false),
    [publishOpen, setPublishOpen] = useState(false);
  const [person, setPerson] = useState(meId),
    [view, setView] = useState('team');
  const t = (en: string, he: string) => (lang === 'en' ? en : he);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
  }, [lang]);
  const duties = useMemo(
    () => blocks(month, state.specials, state.splitWeekends),
    [month, state.specials, state.splitWeekends],
  );
  const monthDetails = state.months[month] ?? {
    deadline: addDays(month + '-01', -7),
    status: 'draft' as const,
  };
  const publication = remote.snapshot!.months.find(
    (m) => m.month === month,
  )?.current_publication_id;
  const requesting = !isManager || view === 'published';
  const calendarState =
    isManager && view === 'published' && publication
      ? fromSnapshot(remote.snapshot!, meId, publication)
      : state;
  const calendarBlocks =
    calendarState === state
      ? duties
      : blocks(month, calendarState.specials, calendarState.splitWeekends);
  const constraintsClosed = isManager
    ? monthDetails.status === 'published'
    : !!remote &&
      (remote.snapshot?.months.find((m) => m.month === month)?.status === 'published' ||
        monthDetails.deadline < todayIsrael());
  const metrics = workspaceMetrics(state, month, duties);
  const locale = lang === 'en' ? 'en-GB' : 'he-IL';
  const fmt = (d: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) =>
    new Date(d + 'T12:00:00Z').toLocaleDateString(locale, { ...opts, timeZone: 'Asia/Jerusalem' });
  const monthLabel = fmt(month + '-15', { month: 'long', year: 'numeric' });
  const personName = (id?: string) =>
    state.team.find((p) => p.id === id)?.name ?? t('Unassigned', 'ללא שיבוץ');
  const nickname = (id?: string) => personName(id).split(' ')[0];
  const dateCells = calendarDates(month);
  const draft = useWorkspaceDraft({ remote, state, month, monthDetails, t });
  const { update, runGenerate, busy } = draft;
  const { selected, setSelected } = draft.editor;
  const interactions = useCalendarInteractions({
    remote,
    state,
    month,
    tab,
    requesting,
    publication,
    duties,
    monthDetails,
    openDuty: draft.editor.openDuty,
    startSwap: draft.swap.start,
  });
  const { requestSelection, setRequestSelection } = interactions;
  function changeMonth(n: number) {
    const m = monthNext(month, n);
    setMonth(m);
    draft.resetSpecialDates(m);
    interactions.resetSelection();
  }
  async function saveConstraints(days: string[], kind: 'no' | 'prefer' | 'clear', note: string) {
    try {
      await remote.constraints(isManager ? person : meId, days, kind, note);
      toast.success(t('Constraints saved.', 'האילוצים נשמרו.'));
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  }
  async function publish() {
    if (
      !(await update(
        (s) => ({
          ...s,
          months: {
            ...s.months,
            [month]: { ...monthDetails, status: 'published', generated: true },
          },
        }),
        false,
      ))
    )
      return;
    setPublishOpen(false);
    toast.success(t('Schedule published.', 'הלוח פורסם.'));
  }
  function exportBackup() {
    const a = document.createElement('a');
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }),
    );
    a.href = url;
    a.download = 'duty-team-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  }
  useEffect(() => {
    const context = (
      document as unknown as {
        modelContext?: { registerTool: (tool: unknown, options: unknown) => void };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      context.registerTool(
        {
          name: 'read_duty_month',
          description:
            'Read the selected month and assignments visible to the signed-in user without changing them.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
          execute: (input: unknown) => {
            if (!input || typeof input !== 'object' || Object.keys(input).length)
              throw Error('Expected empty object');
            return {
              month,
              status: monthDetails.status,
              duties: duties.map((b) => ({ ...b, assignment: state.assignments[b.id] ?? null })),
            };
          },
        },
        { signal: lifecycle.signal },
      );
    } catch {}
    return () => lifecycle.abort();
  }, [state, month, duties, monthDetails.status]);
  return (
    <div className="app-shell" dir={lang === 'he' ? 'rtl' : 'ltr'}>
      <Toaster position="bottom-center" richColors />
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Duty home">
          <span className="brand-symbol">
            d<span>·</span>
          </span>{' '}
          duty
          <span className="brand-divider" />
          <span className="brand-context">{t('Engineering', 'הנדסה')}</span>
        </Link>
        <div className="top-actions">
          <span className="demo-badge">{t('TEAM WORKSPACE', 'סביבת הצוות')}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLang(lang === 'en' ? 'he' : 'en')}
            aria-label={t('Switch to Hebrew', 'Switch to English')}
          >
            <Globe />
          </Button>
          <button
            className="avatar admin-avatar"
            onClick={() => setProfileOpen(true)}
            aria-label={t('My profile', 'הפרופיל שלי')}
          >
            {remote?.me?.name
              .split(' ')
              .map((n) => n[0])
              .join('')
              .slice(0, 2) || 'AM'}
          </button>
          {remote && (
            <Button variant="ghost" size="sm" onClick={() => remote.signOut()}>
              {t('Sign out', 'יציאה')}
            </Button>
          )}
        </div>
      </header>
      <main className="main-wrap">
        <div className="workspace-status">
          <span>
            {remote.saving
              ? t('Saving…', 'שומר…')
              : t('Shared team schedule', 'לוח תורנויות משותף')}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
            <Info />
            {t('Help', 'עזרה')}
          </Button>
        </div>
        {remote?.error && (
          <div className="warning-note" role="alert">
            {remote.error}
            <Button
              variant="ghost"
              onClick={() =>
                remote
                  .refresh()
                  .then(() => remote.clearError())
                  .catch((e) => toast.error(e.message))
              }
            >
              {t('Refresh', 'רענון')}
            </Button>
          </div>
        )}
        <fieldset disabled={!!remote?.saving} className="workspace-controls">
          <Tabs value={tab} onValueChange={setTab} className="main-tabs">
            <div className="nav-row">
              <TabsList variant="line">
                <TabsTrigger value="schedule">
                  <CalendarDays />
                  {t('Schedule', 'לוח תורנויות')}
                </TabsTrigger>
                <TabsTrigger value="availability">
                  <SlidersHorizontal />
                  {t('Availability', 'אילוצים')}
                </TabsTrigger>
                <TabsTrigger value="team">
                  <Users />
                  {t('Team & fairness', 'צוות והוגנות')}
                </TabsTrigger>
              </TabsList>
              <span className="time-zone">09:00 → 09:00 · {t('Israel time', 'שעון ישראל')}</span>
            </div>
            <WorkspaceToolbar
              monthLabel={monthLabel}
              monthDetails={monthDetails}
              isManager={isManager}
              busy={busy}
              metrics={metrics}
              blockCount={duties.length}
              t={t}
              changeMonth={changeMonth}
              runGenerate={runGenerate}
              onHistory={() => setHistoryOpen(true)}
              onSettings={() => setSettings(true)}
              onReopen={() => update((s) => s)}
              onPublish={() => setPublishOpen(true)}
            />
            <TabsContent
              value="schedule"
              forceMount
              style={{ display: tab === 'schedule' ? undefined : 'none' }}
            >
              <div className="workspace-grid">
                <WorkspaceCalendar
                  state={state}
                  calendarState={calendarState}
                  calendarBlocks={calendarBlocks}
                  dateCells={dateCells}
                  month={month}
                  monthDetails={monthDetails}
                  lang={lang}
                  t={t}
                  fmt={fmt}
                  nickname={nickname}
                  meId={meId}
                  isManager={isManager}
                  requesting={requesting}
                  publication={publication}
                  view={view}
                  setView={setView}
                  onSpecial={() => {
                    draft.special.setOpen(true);
                    draft.special.setTitle('');
                  }}
                  metrics={metrics}
                  interactions={interactions}
                  blockCount={duties.length}
                />
                <WorkspaceSummary
                  metrics={metrics}
                  blockCount={duties.length}
                  monthDetails={monthDetails}
                  meId={meId}
                  isManager={isManager}
                  t={t}
                  fmt={fmt}
                  onTeam={() => setTab('team')}
                  onSettings={() => setSettings(true)}
                />
              </div>
            </TabsContent>
            <TabsContent value="availability">
              <WorkspaceAvailability
                state={state}
                month={month}
                person={person}
                setPerson={setPerson}
                dateCells={dateCells}
                lang={lang}
                isManager={isManager}
                meId={meId}
                constraintsClosed={constraintsClosed}
                t={t}
                saveConstraints={saveConstraints}
              />
            </TabsContent>
            <TabsContent value="team">
              <WorkspaceTeam
                remote={remote}
                state={state}
                metrics={metrics}
                meId={meId}
                isManager={isManager}
                lang={lang}
                t={t}
                update={update}
              />
            </TabsContent>
          </Tabs>
          <SwapRequests
            key={month}
            remote={remote}
            month={month}
            lang={lang}
            selection={requestSelection}
            onSelection={setRequestSelection}
          />
        </fieldset>
        <footer className="app-footer">
          <span>Duty</span>
          <button onClick={exportBackup}>
            <Download size={14} />
            {t('Export backup', 'ייצוא גיבוי')}
          </button>
        </footer>
      </main>
      <ProfileDialog remote={remote} open={profileOpen} onOpenChange={setProfileOpen} lang={lang} />
      {isManager && (
        <PublicationHistory
          key={month}
          remote={remote}
          month={month}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          lang={lang}
        />
      )}
      {selected && (
        <DutyEditor
          key={selected.id}
          state={state}
          duty={selected}
          month={month}
          lang={lang}
          onClose={() => setSelected(null)}
          onMonth={(m) => {
            setMonth(m);
            setSelected(null);
          }}
          onSave={draft.editor.save}
          onRemoveSpecial={draft.editor.removeSpecial}
        />
      )}
      <DraftSwapDialog
        controller={draft.swap}
        state={state}
        duties={duties}
        lang={lang}
        t={t}
        fmt={fmt}
        nickname={nickname}
        personName={personName}
      />
      <SpecialDutyDialog form={draft.special} month={month} lang={lang} t={t} fmt={fmt} />
      <MonthSettingsDialog
        settings={settings}
        setSettings={setSettings}
        monthLabel={monthLabel}
        monthDetails={monthDetails}
        lang={lang}
        t={t}
        onDeadline={(deadline) => {
          update(
            (s) => ({ ...s, months: { ...s.months, [month]: { ...monthDetails, deadline } } }),
            false,
          );
        }}
      />
      <PublishDialog
        publishOpen={publishOpen}
        setPublishOpen={setPublishOpen}
        monthLabel={monthLabel}
        assigned={metrics.assigned}
        saving={!!remote?.saving}
        lang={lang}
        t={t}
        onPublish={publish}
      />
      <WorkspaceHelpDialog help={help} setHelp={setHelp} lang={lang} t={t} />
    </div>
  );
}
