'use client';
import {BrandContent,WorkspaceHeader,WorkspaceFooter} from './workspace-frame';
import {initialCalendarMonth,calendarMonthLabel} from '@/lib/rota/calendar-dates';
import {MobileNavigation} from './mobile-navigation';
import {navigationItems,NavigationLabel} from './navigation-presentation';
import {useMobileLayout} from '@/hooks/use-mobile-layout';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {EnvironmentBadge,InspectionWarning} from '@/components/environment-indicator';
import { Info, Globe } from 'lucide-react';
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
  CancelDraftDialog,
  WorkspaceHelpDialog,
} from './workspace-dialogs';
import type { TeamWorkspace } from '@/hooks/use-team-workspace';
import { useWorkspaceDraft } from '@/hooks/use-workspace-draft';
import {useAllocationWorkflow} from '@/hooks/use-allocation-workflow';
import {AllocationDialog} from './allocation-dialog';
import {AllocationOutcome} from './allocation-outcome';
import {allocationTotals} from '@/lib/allocation/review';
import {useIsraelToday} from '@/hooks/use-israel-today';
import { useCalendarInteractions } from '@/hooks/use-calendar-interactions';
import { fromSnapshot } from '@/lib/supabase/snapshot';
import { Toaster, toast } from 'sonner';
import { addDays, monthNext, blocks } from '@/lib/rota/engine';
import { calendarDates, workspaceMetrics, visibleCalendarBlocks } from '@/lib/rota/workspace-data';
export function RotaWorkspace({ remote, lang, setLang }: { remote: TeamWorkspace; lang: 'en' | 'he'; setLang: (lang: 'en' | 'he') => void }) {
  const mobile = useMobileLayout();
  useEffect(() => {
    if (!mobile || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const sync = () => {
      const inset = viewport.scale > 1 ? 0 : Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
      document.documentElement.classList.toggle('keyboard-open', inset > 150);
    };
    sync();
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
      document.documentElement.style.removeProperty('--keyboard-inset');
      document.documentElement.classList.remove('keyboard-open');
    };
  }, [mobile]);
  const isManager = remote.isAdmin,
    meId = remote.user!.id;
  const [month, setMonth] = useState(initialCalendarMonth),
    [tab, setTab] = useState('schedule');
  const state = remote.state!;
  const today = useIsraelToday();
  const [profileOpen, setProfileOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false);
  const [help, setHelp] = useState(false),
    [settings, setSettings] = useState(false),
    [publishOpen, setPublishOpen] = useState(false);
  const [person, setPerson] = useState(meId),
    [calendarChoice, setCalendarChoice] = useState({month: '', status: '', version: 'draft', mine: false});
  const [cancelDraftMonth, setCancelDraftMonth] = useState<string | null>(null);
  const t = (en: string, he: string) => (lang === 'en' ? en : he);
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
  const reopened = isManager && !!publication && monthDetails.status === 'draft';
  const choice = calendarChoice.month === month && calendarChoice.status === monthDetails.status
    ? calendarChoice : {version: 'draft', mine: false};
  const viewingDraft = isManager && monthDetails.status === 'draft' && (!reopened || choice.version === 'draft');
  const requesting = !viewingDraft;
  const view = choice.mine ? 'me' : 'team';
  function setView(next: string) {
    interactions.cancelKeyboard();
    setCalendarChoice({month, status: monthDetails.status, version: choice.version, mine: next === 'me'});
  }
  function setVersion(version: string) {
    interactions.resetSelection();
    setCalendarChoice({month, status: monthDetails.status, version, mine: choice.mine});
  }
  const calendarState = !isManager || viewingDraft ? state : fromSnapshot(remote.snapshot!, meId, undefined, true);
  const calendarBlocks = visibleCalendarBlocks(calendarState, month);
  const constraintsClosed = isManager
    ? monthDetails.status === 'published'
    : !!remote &&
      (remote.snapshot?.months.find((m) => m.month === month)?.status === 'published' ||
        monthDetails.deadline < today);
  const metrics = workspaceMetrics(state, month, duties);
  const displayMetrics = calendarState === state ? metrics : workspaceMetrics(calendarState, month, blocks(month, calendarState.specials, calendarState.splitWeekends));
  const locale = lang === 'en' ? 'en-GB' : 'he-IL';
  const fmt = (d: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) =>
    new Date(d + 'T12:00:00Z').toLocaleDateString(locale, { ...opts, timeZone: 'Asia/Jerusalem' });
  const monthLabel = calendarMonthLabel(month,lang);
  const personName = (id?: string) =>
    state.team.find((p) => p.id === id)?.name ?? t('Unassigned', 'ללא שיבוץ');
  const nickname = (id?: string) => personName(id).split(' ')[0];
  const dateCells = calendarDates(month);
  const draft = useWorkspaceDraft({ remote, state, month, monthDetails, t });
  const { update } = draft;
  const allocation = useAllocationWorkflow(remote, month, t);
  const generationClosed = allocation.closed;
  const confirmedTotals = allocation.captured?.allocation ? allocationTotals(allocation.captured.input, allocation.captured.allocation, allocation.captured.assignments) : null;
  const allocationMismatch = !!confirmedTotals?.rows.some(r => r.assigned !== r.target);
  const { selected, setSelected } = draft.editor;
  const interactions = useCalendarInteractions({
    remote,
    state,
    month,
    tab,
    today,
    requesting,
    publication,
    duties: calendarBlocks,
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
    setCalendarChoice({month: m, status: '', version: 'draft', mine: false});
    setSelected(null);
    draft.swap.setSelection(null);
    setPublishOpen(false);
    setCancelDraftMonth(null);
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
    setCalendarChoice({month, status: 'published', version: 'draft', mine: false});
    interactions.resetSelection();
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
      <WorkspaceHeader brand={<Link className="brand" href="/" aria-label="Duty home"><BrandContent t={t}/></Link>}>
          {remote.environment?.badge?<EnvironmentBadge environment={remote.environment}/>:<span className="demo-badge">{t('TEAM WORKSPACE', 'סביבת הצוות')}</span>}
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
      </WorkspaceHeader>
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
        <InspectionWarning environment={remote.environment} lang={lang}/>
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
          {/* Keep the fieldset's layout child stable when month-keyed requests remount.
              Otherwise Chromium can skip the preceding size-query toolbar subtree. */}
          <div>
          <Tabs value={tab} onValueChange={setTab} className="main-tabs" dir={mobile ? (lang === 'he' ? 'rtl' : 'ltr') : undefined}>
            <div className="nav-row">
              {mobile ? <MobileNavigation value={tab} onChange={setTab} t={t} rtl={lang === 'he'} disabled={remote.saving}/> : <TabsList variant="line">
                {navigationItems(t).map(item=><TabsTrigger key={item.value} value={item.value} aria-label={item.label}><NavigationLabel item={item}/></TabsTrigger>)}
              </TabsList>}
              <span className="time-zone">09:00 → 09:00 · {t('Israel time', 'שעון ישראל')}</span>
            </div>
            <WorkspaceToolbar
              monthLabel={monthLabel}
              monthDetails={monthDetails}
              isManager={isManager}
              readOnly={remote.readOnly}
              busy={allocation.busy}
              generationClosed={generationClosed}
              allocationMismatch={allocationMismatch}
              metrics={metrics}
              blockCount={metrics.owned.length}
              t={t}
              changeMonth={changeMonth}
              runGenerate={allocation.show}
              onHistory={() => setHistoryOpen(true)}
              onSettings={() => setSettings(true)}
              reopened={reopened}
              onCancelDraft={() => setCancelDraftMonth(month)}
              onReopen={async () => {
                if (!publication) return;
                try {await remote.restore(publication)} catch (e) {toast.error((e as Error).message)}
              }}
              onPublish={() => setPublishOpen(true)}
            />
            <TabsContent
              value="schedule"
              forceMount
              style={{ display: tab === 'schedule' ? undefined : 'none' }}
            >
              {isManager && generationClosed && monthDetails.status === 'draft' && <p className="generation-cutoff-note">{t('Coverage has started. Use manual assignments or swaps; generation is closed.', 'הכיסוי החודשי התחיל. יש לערוך שיבוצים ידנית או לבצע החלפות; השיבוץ האוטומטי נסגר.')}</p>}
              {isManager && viewingDraft && <AllocationOutcome flow={allocation} state={state} lang={lang} t={t}/>}
              <div className="workspace-grid">
                <WorkspaceCalendar
                  state={state}
                  calendarState={calendarState}
                  calendarBlocks={calendarBlocks}
                  dateCells={dateCells}
                  today={today}
                  month={month}
                  monthDetails={monthDetails}
                  lang={lang}
                  t={t}
                  fmt={fmt}
                  nickname={nickname}
                  meId={meId}
                  isManager={isManager}
                  readOnly={remote.readOnly}
                  requesting={requesting}
                  publication={publication}
                  view={view}
                  setView={setView}
                  reopened={reopened}
                  viewingDraft={viewingDraft}
                  setVersion={setVersion}
                  onSpecial={() => {
                    draft.special.setOpen(true);
                    draft.special.setTitle('');
                  }}
                  metrics={displayMetrics}
                  interactions={interactions}
                  blockCount={displayMetrics.owned.length}
                />
                <WorkspaceSummary
                  readOnly={remote.readOnly}
                  metrics={displayMetrics}
                  blockCount={displayMetrics.owned.length}
                  monthDetails={monthDetails}
                  meId={meId}
                  isManager={isManager}
                  t={t}
                  fmt={fmt}
                  onTeam={() => setTab('team')}
                  onSettings={() => {if(!remote.readOnly)setSettings(true)}}
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
                constraintsClosed={constraintsClosed||remote.readOnly}
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
          </div>
        </fieldset>
        <WorkspaceFooter t={t} onExport={exportBackup}/>
      </main>
      <ProfileDialog remote={remote} open={profileOpen} onOpenChange={setProfileOpen} lang={lang} />
      {isManager && allocation.open && <AllocationDialog flow={allocation} state={state} monthLabel={monthLabel} lang={lang} t={t}/>}
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
          saving={remote.saving}
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
      <CancelDraftDialog open={cancelDraftMonth !== null} onOpenChange={open => {if (!open) setCancelDraftMonth(null)}} saving={remote.saving} lang={lang} t={t} monthLabel={monthLabel} onConfirm={async () => {
        if (!cancelDraftMonth) return;
        try {
          await remote.cancelDraft(cancelDraftMonth);
          interactions.resetSelection();
          setSelected(null);
          draft.swap.setSelection(null);
          setCancelDraftMonth(null);
          setCalendarChoice({month, status: 'published', version: 'draft', mine: false});
          toast.success(t('Published schedule restored.', '\u05d4\u05dc\u05d5\u05d7 \u05e9\u05e4\u05d5\u05e8\u05e1\u05dd \u05e9\u05d5\u05d7\u05d6\u05e8.'));
        } catch (e) {toast.error((e as Error).message)}
      }}/>
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
