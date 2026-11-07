'use client';
import {initialCalendarMonth, calendarMonthLabel} from '@/lib/rota/calendar-dates';
import {useMobileLayout} from '@/hooks/use-mobile-layout';
import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {EnvironmentBadge, InspectionWarning} from '@/components/environment-indicator';
import {Check, Eraser, History, Plus, RefreshCw, SlidersHorizontal, Sparkles, Trash2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Avatar} from '@/components/ui/avatar';
import {Segmented} from '@/components/ui/segmented';
import {TabsContent} from '@/components/ui/tabs';
import {AppToaster} from '@/components/ui/toast';
import {AppShell} from '@/components/shell/app-shell';
import {HomeScreen} from '@/components/home/home-screen';
import {Welcome, welcomeSeen} from '@/components/home/welcome';
import {Chip} from '@/components/ui/chip';
import {WifiOff} from 'lucide-react';
import {ActivityBell} from './activity-bell';
import {MonthBar, type MenuItem, type PrimaryAction} from './month-bar';
import {MonthStage, type MonthStageHandle} from './month-stage';
import {DutySheet, type DutySheetActions} from './duty-sheet';
import {DayDetails} from './day-details';
import {DutyEditor} from '@/components/rota/duty-editor';
import {PublishedDutyEditor} from '@/components/rota/published-duty-editor';
import {editablePublishedDuty} from '@/lib/supabase/published-edit';
import {SettingsScreen} from '@/components/rota/settings-screen';
import {deepLink} from '@/lib/push/settings';
import {currentSubscription, describe} from '@/lib/push/browser';
import {PublicationHistory} from '@/components/rota/publication-history';
import {SwapRequestDialog, useSwapActions} from '@/components/rota/swap-requests';
import {WorkspaceAvailability} from './workspace-availability';
import {WorkspaceCalendar} from './workspace-calendar';
import {WorkspaceTeam} from './workspace-team';
import {DraftSwapDialog, SpecialDutyDialog, MonthSettingsDialog, PublishDialog, CancelDraftDialog, ClearBoardDialog} from './workspace-dialogs';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import {useWorkspaceDraft} from '@/hooks/use-workspace-draft';
import {useAllocationWorkflow} from '@/hooks/use-allocation-workflow';
import {AllocationDialog} from './allocation-dialog';
import {allocationTotals, repaymentsTaken} from '@/lib/allocation/review';
import {useIsraelToday} from '@/hooks/use-israel-today';
import {useCalendarInteractions} from '@/hooks/use-calendar-interactions';
import {fromSnapshot} from '@/lib/supabase/snapshot';
import {toast} from 'sonner';
import {addDays, monthNext, blocks, ownerMonth, type Duty} from '@/lib/rota/engine';
import {calendarDates, workspaceMetrics, visibleCalendarBlocks} from '@/lib/rota/workspace-data';
import {userMessage} from '@/lib/messages';

export function RotaWorkspace({remote, lang, setLang}: {remote: TeamWorkspace; lang: 'en' | 'he'; setLang: (lang: 'en' | 'he') => void}) {
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
  const isManager = remote.isAdmin, meId = remote.memberId;
  // A notification opens the screen it links to (`/?tab=…&month=…`, decision 2026-11-06).
  const [link] = useState(() => typeof window === 'undefined' ? {} : deepLink(window.location.search));
  const [month, setMonth] = useState(() => link.month ?? initialCalendarMonth()), [tab, setTab] = useState<string>(link.tab ?? 'home');
  const [welcome, setWelcome] = useState(() => typeof window !== 'undefined' && !welcomeSeen());
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('tab') || url.searchParams.has('month')) {
      url.searchParams.delete('tab'); url.searchParams.delete('month');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    // A notification tapped while the app is open (public/sw.js falls back to a message).
    const open = (event: MessageEvent) => {
      if (event.data?.type !== 'duty-open' || typeof event.data.url !== 'string') return;
      const next = deepLink(event.data.url.replace(/^\/\?/, '?'));
      if (next.month) setMonth(next.month);
      if (next.tab) setTab(next.tab);
    };
    navigator.serviceWorker?.addEventListener('message', open);
    // The offline shell (public/sw.js); push subscribes through the same registration.
    navigator.serviceWorker?.register('/sw.js', {scope: '/'}).catch(() => {});
    // A device that already receives notifications belongs to whoever is signed in now.
    if (!remote.readOnly && typeof Notification !== 'undefined' && Notification.permission === 'granted')
      void currentSubscription().then(subscription => subscription && remote.personal.saveDevice(describe(subscription))).catch(() => {});
    return () => navigator.serviceWorker?.removeEventListener('message', open);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per signed-in workspace
  }, []);
  const state = remote.state!;
  const today = useIsraelToday();
  const [settingsOpen, setSettingsOpen] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
  const [settings, setSettings] = useState(false), [publishOpen, setPublishOpen] = useState(false);
  const [person, setPerson] = useState(meId), [calendarChoice, setCalendarChoice] = useState({month: '', status: '', version: 'draft'});
  const [cancelDraftMonth, setCancelDraftMonth] = useState<string | null>(null);
  const [publishedEdit, setPublishedEdit] = useState<string | null>(null);
  // The tapped day (phone details) and the duty whose sheet is open; an admin's draft swap waiting for its second duty.
  const [selectedDay, setSelectedDay] = useState<string | null>(null), [sheetDuty, setSheetDuty] = useState<Duty | null>(null), [pickingFrom, setPickingFrom] = useState<string | null>(null);
  // Split weekends the plan pointed at ("Show"): their days pulse briefly in the calendar.
  const [flashDays, setFlashDays] = useState<string[]>([]);
  useEffect(() => {if (!flashDays.length) return; const timer = setTimeout(() => setFlashDays([]), 2400); return () => clearTimeout(timer);}, [flashDays]);
  const t = (en: string, he: string) => (lang === 'en' ? en : he);
  const duties = useMemo(() => blocks(month, state.specials, state.splitWeekends), [month, state.specials, state.splitWeekends]);
  const monthDetails = state.months[month] ?? {deadline: addDays(month + '-01', -7), status: 'draft' as const};
  const publication = remote.snapshot!.months.find((m) => m.month === month)?.current_publication_id;
  const reopened = isManager && !!publication && monthDetails.status === 'draft';
  const choice = calendarChoice.month === month && calendarChoice.status === monthDetails.status ? calendarChoice : {version: 'draft'};
  const viewingDraft = isManager && monthDetails.status === 'draft' && (!reopened || choice.version === 'draft');
  const requesting = !viewingDraft;
  function setVersion(version: string) {
    interactions.resetSelection(); setPickingFrom(null); setSheetDuty(null);
    setCalendarChoice({month, status: monthDetails.status, version});
  }
  // The published calendar, built once per snapshot: the current month and its neighbours share it.
  const publishedState = useMemo(() => fromSnapshot(remote.snapshot!, meId, undefined, true), [remote.snapshot, meId]);
  const calendarState = !isManager || viewingDraft ? state : publishedState;
  const calendarBlocks = visibleCalendarBlocks(calendarState, month);
  const constraintsClosed = isManager
    ? monthDetails.status === 'published'
    : (remote.snapshot?.months.find((m) => m.month === month)?.status === 'published' || monthDetails.deadline < today);
  const metrics = workspaceMetrics(state, month, duties);
  const locale = lang === 'en' ? 'en-GB' : 'he-IL';
  const fmt = (d: string, opts: Intl.DateTimeFormatOptions = {day: 'numeric', month: 'short'}) => new Date(d + 'T12:00:00Z').toLocaleDateString(locale, {...opts, timeZone: 'Asia/Jerusalem'});
  const monthLabel = calendarMonthLabel(month, lang);
  const personName = (id?: string) => state.team.find((p) => p.id === id)?.name ?? t('Unassigned', 'ללא שיבוץ');
  const nickname = (id?: string) => personName(id).split(' ')[0];
  const dateCells = calendarDates(month);
  const draft = useWorkspaceDraft({remote, state, month, monthDetails, t});
  const {update} = draft;
  const allocation = useAllocationWorkflow(remote, month, t);
  const generationClosed = allocation.closed;
  const confirmedTotals = allocation.captured?.allocation ? allocationTotals(allocation.captured.input, allocation.captured.allocation, allocation.captured.assignments) : null;
  const allocationMismatch = !!confirmedTotals?.rows.some(r => r.assigned !== r.target);
  const captured = allocation.captured;
  const taken = useMemo(() => !!captured?.allocation && !captured.sourcePublicationId && repaymentsTaken(captured.input, captured.allocation), [captured]);
  // Plan the month is where a generated month is reviewed; the primary action marks waiting notes.
  const outcome = allocation.outcome?.generated ? allocation.outcome : null;
  const reviewNotes = !outcome || !confirmedTotals ? 0 : confirmedTotals.rows.filter(r => r.assigned !== r.target || outcome.backToBack[r.id]).length +
    (confirmedTotals.uncovered.length ? 1 : 0) + (allocation.result && !allocation.result.search.allStagesProved ? 1 : 0);
  // Why Publish is disabled, in one line: who differs from the saved plan, and open duties.
  const unassigned = metrics.owned.length - metrics.assigned;
  const publishBlockers = metrics.assigned && (monthDetails.generated || unassigned === 0) ? [
    ...(confirmedTotals?.rows.filter(r => r.assigned !== r.target).map(r => t(`${nickname(r.id)}: ${r.assigned / 2} scheduled, plan says ${r.target / 2}`, `${nickname(r.id)}: שובצו ${r.assigned / 2}, בתוכנית ${r.target / 2}`)) ?? []),
    ...(unassigned > 0 ? [t(`${unassigned} without a primary`, `${unassigned} ללא שיבוץ`)] : []),
    ...(captured?.allocation && !captured.sourcePublicationId && allocation.replanBlocked ? [userMessage(allocation.replanBlocked, t)] : []),
    ...(taken ? [t('A month published since this plan was confirmed repays the same debt. Open the plan and confirm it again', 'חודש שפורסם אחרי שהתוכנית אושרה מחזיר את אותו חוב. יש לפתוח את התוכנית ולאשר אותה שוב')] : []),
  ] : [];
  const {selected, setSelected} = draft.editor;
  const interactions = useCalendarInteractions({
    remote, state, month, tab, today, lang, requesting, publication, duties: calendarBlocks, monthDetails,
    openDuty: draft.editor.openDuty, startSwap: draft.swap.start,
    // A reopened month's draft was copied from this version; edits wait until it is published or cancelled.
    editPublished: isManager && !remote.readOnly && monthDetails.status === 'published' ? (day) => {
      if (!editablePublishedDuty(remote.snapshot!, month, today, day)) return false;
      setPublishedEdit(day);
      return true;
    } : undefined,
  });
  const publishedEditRow = publishedEdit ? editablePublishedDuty(remote.snapshot!, month, today, publishedEdit) : undefined;
  const {requestSelection, setRequestSelection} = interactions;
  function goToMonth(m: string) {
    setMonth(m);
    draft.resetSpecialDates(m);
    interactions.resetSelection();
    setCalendarChoice({month: m, status: '', version: 'draft'});
    setSelected(null); setPublishedEdit(null); setSelectedDay(null); setSheetDuty(null); setPickingFrom(null);
    draft.swap.setSelection(null);
    setPublishOpen(false); setCancelDraftMonth(null); draft.clear.setOpen(false);
  }
  function changeMonth(n: number) {goToMonth(monthNext(month, n));}
  // Escape ends an admin's draft swap pick, like the keyboard swap.
  useEffect(() => {
    if (!pickingFrom) return;
    const onKey = (event: KeyboardEvent) => {if (event.key === 'Escape') setPickingFrom(null);};
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickingFrom]);
  async function saveConstraints(days: string[], kind: 'no' | 'prefer' | 'clear', note: string) {
    try {
      await remote.constraints(isManager ? person : meId, days, kind, note);
      toast.success(t('Saved', 'נשמר'));
      return true;
    } catch (e) {toast.error(userMessage((e as Error).message, t)); return false;}
  }
  async function publish() {
    if (!(await update((s) => ({...s, months: {...s.months, [month]: {...monthDetails, status: 'published', generated: true}}}), false))) return;
    setPublishOpen(false);
    setCalendarChoice({month, status: 'published', version: 'draft'});
    interactions.resetSelection();
    toast.success(t('Published', 'פורסם'));
  }
  function exportBackup() {
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], {type: 'application/json'}));
    a.href = url; a.download = 'duty-team-backup.json'; a.click();
    URL.revokeObjectURL(url);
  }
  useEffect(() => {
    const context = (document as unknown as {modelContext?: {registerTool: (tool: unknown, options: unknown) => void}}).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      context.registerTool({
        name: 'read_duty_month',
        description: 'Read the selected month and assignments visible to the signed-in user without changing them.',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false},
        annotations: {readOnlyHint: true},
        execute: (input: unknown) => {
          if (!input || typeof input !== 'object' || Object.keys(input).length) throw Error('Expected empty object');
          return {month, status: monthDetails.status, duties: duties.map((b) => ({...b, assignment: state.assignments[b.id] ?? null}))};
        },
      }, {signal: lifecycle.signal});
    } catch {}
    return () => lifecycle.abort();
  }, [state, month, duties, monthDetails.status]);

  // A tap on a day: an admin's second swap pick, the phone's day details, or the duty sheet.
  function selectDay(b: Duty, d: string) {
    if (pickingFrom) {
      if (b.id !== pickingFrom) draft.swap.start(pickingFrom, b.id);
      setPickingFrom(null);
      return;
    }
    // Phones: a second tap on the selected day clears it (owner round 2).
    if (mobile) {setSelectedDay(selectedDay === d ? null : d); return;}
    setSheetDuty(b);
  }
  const sheetActions = (b: Duty | null): DutySheetActions => {
    if (!b) return {};
    const a = calendarState.assignments[b.id];
    const actions: DutySheetActions = {};
    if (requesting) {
      if (!publication) actions.swap = {onClick: () => {}, reason: t('Not published yet', 'עדיין לא פורסם')};
      else if (interactions.swapSourceDays.has(b.id)) actions.swap = {onClick: () => {setSheetDuty(null); interactions.setKeyboardSource(b.id); toast.info(t('Now choose the duty to swap with', 'עכשיו בוחרים את התורנות להחלפה'), {id: 'swap-pick'});}};
      else actions.swap = {onClick: () => {}, reason: !a?.primary ? t('No one is on this duty', 'אין תורן/ית בתורנות הזו') : b.start < today ? t('This day has passed', 'היום הזה עבר') : a.primary !== meId && !isManager ? t('Only your own duties can be swapped', 'אפשר להחליף רק תורנויות שלך') : t('This duty can’t be swapped now', 'אי אפשר להחליף את התורנות הזו כרגע')};
      if (isManager) actions.edit = {onClick: () => {setSheetDuty(null); setPublishedEdit(b.id);}, reason: remote.readOnly ? t('Read-only', 'לקריאה בלבד') : monthDetails.status !== 'published' ? t('Publish or cancel the draft first', 'יש לפרסם או לבטל את הטיוטה קודם') : !editablePublishedDuty(remote.snapshot!, month, today, b.id) ? t('This day has passed', 'היום הזה עבר') : undefined};
    } else {
      actions.swap = a?.primary ? {onClick: () => {setSheetDuty(null); setPickingFrom(b.id); toast.info(t('Now choose the duty to swap with', 'עכשיו בוחרים את התורנות להחלפה'), {id: 'swap-pick'});}} : {onClick: () => {}, reason: t('No one is on this duty yet', 'אין עדיין תורן/ית בתורנות הזו')};
      actions.edit = {onClick: () => {setSheetDuty(null); draft.editor.openDuty(b);}, reason: remote.readOnly ? t('Read-only', 'לקריאה בלבד') : undefined};
    }
    return actions;
  };

  // One state-driven primary action and a ⋯ menu for the rare ones (decision 2026-11-06).
  const publishable = !allocationMismatch && metrics.assigned === metrics.owned.length && !metrics.conflicts.length && !!metrics.owned.length && !publishBlockers.length;
  const planLabel = t('Plan the month', 'תכנון החודש'), closedReason = t('Coverage has started: manual edits and swaps only', 'הכיסוי החודשי התחיל: רק עריכה ידנית והחלפות');
  let primary: PrimaryAction | undefined, menu: MenuItem[] = [];
  if (isManager) {
    const plan: PrimaryAction = {label: allocation.busy ? t('Generating…', 'משבץ…') : planLabel, icon: <Sparkles className={allocation.busy ? 'spin' : undefined}/>, onClick: allocation.show, busy: allocation.busy,
      disabled: remote.readOnly || (generationClosed && !monthDetails.generated) || !metrics.active.length, reason: generationClosed && !monthDetails.generated ? closedReason : !metrics.active.length ? t('Add active members first', 'יש להוסיף חברי צוות פעילים קודם') : undefined};
    if (monthDetails.status === 'published') primary = {label: t('Reopen', 'פתיחה לעריכה'), variant: 'secondary', icon: <History/>, disabled: remote.readOnly, onClick: async () => {
      if (!publication) return;
      try {await remote.restore(publication);} catch (e) {toast.error(userMessage((e as Error).message, t));}
    }};
    else if (!viewingDraft) primary = undefined;
    else if (publishable) primary = {label: t('Publish', 'פרסום'), icon: <Check/>, disabled: remote.readOnly || allocation.busy, onClick: () => setPublishOpen(true)};
    else if (!monthDetails.generated) primary = plan;
    else primary = {...plan, label: allocation.busy ? t('Generating…', 'משבץ…') : t('Review plan', 'בדיקת התוכנית'), dot: reviewNotes > 0, disabled: remote.readOnly || allocation.busy, reason: publishBlockers.join(' · ') || undefined};
    menu = [
      ...(viewingDraft && primary !== plan && primary?.label !== planLabel ? [{key: 'plan', label: planLabel, icon: <Sparkles/>, onSelect: allocation.show, disabled: plan.disabled || allocation.busy, reason: plan.reason}] : []),
      {key: 'versions', label: t('Versions', 'גרסאות'), icon: <History/>, onSelect: () => setHistoryOpen(true)},
      {key: 'deadline', label: t('Constraints deadline', 'מועד אחרון לאילוצים'), icon: <SlidersHorizontal/>, onSelect: () => setSettings(true), disabled: remote.readOnly},
      ...(viewingDraft ? [
        {key: 'special', label: t('Special block', 'מקטע מיוחד'), icon: <Plus/>, onSelect: () => {draft.special.setOpen(true); draft.special.setTitle('');}, disabled: remote.readOnly},
        {key: 'clear', label: t('Clear board', 'ניקוי הלוח'), icon: <Eraser/>, onSelect: () => draft.clear.setOpen(true), disabled: remote.readOnly || allocation.busy || !draft.clear.count,
          reason: allocation.busy ? t('Wait for Generate to finish', 'יש להמתין לסיום השיבוץ') : !draft.clear.count ? t('Nothing to clear', 'אין מה לנקות') : undefined},
      ] : []),
      ...(reopened ? [{key: 'cancel', label: t('Cancel draft', 'ביטול טיוטה'), icon: <Trash2/>, danger: true, onSelect: () => setCancelDraftMonth(month), disabled: remote.readOnly || allocation.busy}] : []),
    ];
  }
  const status = isManager
    ? monthDetails.status === 'published' ? {text: t('Published', 'פורסם'), tone: 'ok' as const} : reopened ? {text: t('Reopened', 'נפתח מחדש'), tone: 'warn' as const} : {text: t('Draft', 'טיוטה'), tone: 'neutral' as const}
    : publication ? {text: t('Published', 'פורסם'), tone: 'ok' as const} : {text: t('Not published yet', 'עדיין לא פורסם'), tone: 'neutral' as const};
  const selectedDuty = selectedDay ? calendarBlocks.find(b => b.start <= selectedDay && selectedDay < b.end) : undefined;
  // The chevrons and the heading drag play the calendar's month transition (month-stage.tsx).
  const stage = useRef<MonthStageHandle>(null);
  const navigateMonth = (n: number) => {if (stage.current) stage.current.go(n); else changeMonth(n);};
  // The neighbouring month while it slides in: the same calendar from the data already loaded (the
  // snapshot holds every month), as it will look once it lands, minus the blur.
  const neighbour = (m: string) => {
    const draftView = isManager && (state.months[m]?.status ?? 'draft') === 'draft', s = !isManager || draftView ? state : publishedState;
    return <WorkspaceCalendar preview state={state} calendarState={s} calendarBlocks={visibleCalendarBlocks(s, m)} dateCells={calendarDates(m)} today={today} month={m} lang={lang} t={t} fmt={fmt}
      nickname={nickname} meId={meId} readOnly={remote.readOnly} requesting={!draftView} interactions={interactions} onSelect={() => {}} selectedDay={null}/>;
  };
  const swaps = useSwapActions(remote, lang);
  const notices: ReactNode = <>
    {isManager && viewingDraft && generationClosed && monthDetails.status === 'draft' && <p className="note-line">{closedReason}</p>}
    {isManager && viewingDraft && !remote.readOnly && !!publishBlockers.length && <p className="note-line" role="note" data-publish-blocked>
      <span>{t('Publish waits: ', 'הפרסום ממתין: ')}{publishBlockers.join(' · ')}</span>
      {confirmedTotals && <Button size="xs" variant="link" disabled={allocation.busy} onClick={allocation.show}>{t('Open plan', 'פתיחת התוכנית')}</Button>}
    </p>}
    {isManager && viewingDraft && !!metrics.conflicts.length && <p className="note-line" data-tone="warn">{t(`${metrics.conflicts.length} duties conflict with availability`, `${metrics.conflicts.length} תורנויות מתנגשות עם אילוצים`)}</p>}
  </>;
  const openSchedule = (m: string) => {if (m !== month) goToMonth(m); setTab('schedule');};
  return <>
    <AppToaster/>
    <AppShell lang={lang} t={t} tab={tab} onRefresh={() => remote.refresh()} setTab={next => {setTab(next); if (next !== 'schedule') {setPickingFrom(null); setSheetDuty(null);}}} disabled={!!remote.saving}
      badge={<>{remote.offline && <Chip tone="warn" size="sm" className="offline-pill" role="status"><WifiOff/>{t('Offline', 'לא מקוון')}</Chip>}{remote.environment?.badge ? <EnvironmentBadge environment={remote.environment}/> : null}</>}
      bell={<ActivityBell raw={remote.snapshot!} me={meId} admin={isManager} lang={lang} onOpenMonth={openSchedule}/>}
      avatar={<button type="button" className="avatar-button admin-avatar" data-settings-button onClick={() => setSettingsOpen(true)} aria-label={t('Settings', 'הגדרות')} title={t('Settings', 'הגדרות')}>
        <Avatar name={remote.me?.name ?? ''} color={remote.me?.color} size={36}/>
      </button>}
      status={remote.saving ? <span className="side-status" role="status">{t('Saving…', 'שומר…')}</span> : undefined}>
      <InspectionWarning environment={remote.environment} lang={lang}/>
      {remote?.error && <div className="note-card" role="alert" data-tone="danger">
        <span>{userMessage(remote.error, t)}</span>
        <Button variant="ghost" size="sm" onClick={() => remote.refresh().then(() => remote.clearError()).catch((e) => toast.error(userMessage(e.message, t)))}><RefreshCw/>{t('Refresh', 'רענון')}</Button>
      </div>}
      <fieldset disabled={!!remote?.saving} className="workspace-controls">
        <div>
          <TabsContent value="home">
            <HomeScreen remote={remote} swaps={swaps} today={today} lang={lang} t={t} onSchedule={openSchedule} onAvailability={m => {if (m !== month) goToMonth(m); setTab('availability');}} onTeam={() => setTab('team')}
              onSwap={(m, day) => {
                if (m !== month) goToMonth(m);
                const details = state.months[m];
                if (isManager && details?.status === 'draft') setCalendarChoice({month: m, status: details.status, version: 'published'});
                setTab('schedule');
                interactions.setKeyboardSource(day);
                toast.info(t('Now choose the duty to swap with', 'עכשיו בוחרים את התורנות להחלפה'), {id: 'swap-pick'});
              }}/>
          </TabsContent>
          <TabsContent value="schedule" forceMount style={{display: tab === 'schedule' ? undefined : 'none'}}>
            <MonthBar month={month} label={monthLabel} status={status} t={t} onChange={navigateMonth} primary={primary} menu={menu}
              gesture={{drag: dx => stage.current?.drag(dx), release: (dx, speed, threshold) => stage.current?.release(dx, speed, threshold)}}>
              {reopened && <Segmented label={t('Schedule version', 'גרסת לוח')} value={viewingDraft ? 'draft' : 'published'} onChange={setVersion}
                options={[{value: 'draft', label: t('Draft', 'טיוטה')}, {value: 'published', label: t('Published', 'פורסם')}]}/>}
            </MonthBar>
            <MonthStage ref={stage} month={month} rtl={lang === 'he'} onChange={changeMonth} preview={neighbour}>
                <WorkspaceCalendar state={state} calendarState={calendarState} calendarBlocks={calendarBlocks} dateCells={dateCells} today={today} month={month} lang={lang} t={t} fmt={fmt}
                  nickname={nickname} meId={meId} readOnly={remote.readOnly} requesting={requesting} interactions={interactions} onSelect={selectDay}
                  selectedDay={mobile ? selectedDay : null} pickingFrom={pickingFrom} notices={notices} flashDays={flashDays}/>
            </MonthStage>
            {mobile && selectedDay && <DayDetails date={selectedDay} duty={selectedDuty && ownerMonth(selectedDuty) === month ? selectedDuty : undefined} state={calendarState} lang={lang} t={t} meId={meId}
              interactive={!remote.readOnly} onOpen={b => setSheetDuty(b)}/>}
          </TabsContent>
          <TabsContent value="availability">
            <WorkspaceAvailability state={state} month={month} monthLabel={monthLabel} onMonth={changeMonth} person={person} setPerson={setPerson} dateCells={dateCells} lang={lang} isManager={isManager} meId={meId}
              constraintsClosed={constraintsClosed || remote.readOnly} deadline={monthDetails.deadline} t={t} saveConstraints={saveConstraints}/>
          </TabsContent>
          <TabsContent value="team">
            <WorkspaceTeam remote={remote} state={state} metrics={metrics} month={month} monthLabel={monthLabel} onMonth={changeMonth} meId={meId} isManager={isManager} lang={lang} t={t} update={update}/>
          </TabsContent>
        </div>
      </fieldset>
    </AppShell>
    {swaps.dialogs}
    <Welcome open={welcome} onClose={() => setWelcome(false)} lang={lang} t={t}/>
    {/* Sibling keys must differ: both dialogs reset when the month changes, and React needs one unique key per child. */}
    <SwapRequestDialog key={`swap-request-${month}`} remote={remote} month={month} lang={lang} selection={requestSelection} onSelection={setRequestSelection}/>
    <DutySheet duty={sheetDuty} state={calendarState} lang={lang} t={t} meId={meId} open={!!sheetDuty} onClose={() => setSheetDuty(null)} actions={sheetActions(sheetDuty)} published={requesting && !!publication}/>
    <SettingsScreen remote={remote} open={settingsOpen} onOpenChange={setSettingsOpen} lang={lang} setLang={setLang} onExport={isManager ? exportBackup : undefined}/>
    {isManager && allocation.open && <AllocationDialog flow={allocation} state={state} month={month} monthLabel={monthLabel} lang={lang} t={t}
      onShowSplits={fridays => {allocation.close(); setTab('schedule'); if (mobile) setSelectedDay(fridays[0]); setFlashDays(fridays.flatMap(f => [f, addDays(f, 1)]));}}/>}
    {isManager && <PublicationHistory key={`history-${month}`} remote={remote} month={month} open={historyOpen} onOpenChange={setHistoryOpen} lang={lang}/>}
    {selected && <DutyEditor key={selected.id} state={state} duty={selected} month={month} lang={lang} onClose={() => setSelected(null)} saving={remote.saving}
      onMonth={(m) => {goToMonth(m); setSelected(null);}} onSave={draft.editor.save} onRemoveSpecial={draft.editor.removeSpecial}/>}
    {publishedEditRow && <PublishedDutyEditor key={publishedEditRow.day} remote={remote} row={publishedEditRow} lang={lang} onClose={() => setPublishedEdit(null)}
      onSwap={interactions.swapSourceDays.has(publishedEditRow.day) ? () => {setPublishedEdit(null); interactions.setKeyboardSource(publishedEditRow.day);} : undefined}/>}
    <DraftSwapDialog controller={draft.swap} state={state} duties={duties} lang={lang} t={t} fmt={fmt} nickname={nickname} personName={personName}/>
    <CancelDraftDialog open={cancelDraftMonth !== null} onOpenChange={open => {if (!open) setCancelDraftMonth(null);}} saving={remote.saving} lang={lang} t={t} monthLabel={monthLabel} onConfirm={async () => {
      if (!cancelDraftMonth) return;
      try {
        await remote.cancelDraft(cancelDraftMonth);
        interactions.resetSelection(); setSelected(null); draft.swap.setSelection(null); setCancelDraftMonth(null);
        setCalendarChoice({month, status: 'published', version: 'draft'});
        toast.success(t('Published schedule restored', 'הלוח שפורסם שוחזר'));
      } catch (e) {toast.error(userMessage((e as Error).message, t));}
    }}/>
    <ClearBoardDialog open={draft.clear.open} onOpenChange={draft.clear.setOpen} saving={remote.saving} lang={lang} t={t} monthLabel={monthLabel} count={draft.clear.count} onConfirm={draft.clear.confirm}/>
    <SpecialDutyDialog form={draft.special} month={month} lang={lang} t={t} fmt={fmt}/>
    <MonthSettingsDialog settings={settings} setSettings={setSettings} monthLabel={monthLabel} monthDetails={monthDetails} lang={lang} t={t}
      onDeadline={(deadline) => {update((s) => ({...s, months: {...s.months, [month]: {...monthDetails, deadline}}}), false);}}/>
    <PublishDialog publishOpen={publishOpen} setPublishOpen={setPublishOpen} monthLabel={monthLabel} assigned={metrics.assigned} saving={!!remote?.saving} lang={lang} t={t} onPublish={publish}/>
  </>;
}

/** A quick horizontal swipe on the calendar changes the month (the hold-and-drag swap starts
 * only after a long press, so the two never meet). Mirrored in Hebrew. */
