'use client';
import {useEffect, useMemo, useRef, useState} from 'react';
import {toast} from 'sonner';
import type {TeamWorkspace} from './use-team-workspace';
import {generationNow, schedulingSupported} from '@/lib/allocation/client';
import {allocationTotals, reviewAllocation} from '@/lib/allocation/review';
import {balanced, classifyTransfer, editAllocation, editOptions, persistedDraft, transferAllocation, unplacedChanges} from '@/lib/allocation/edits';
import {allocationCeilings, proposeAllocation, retainedChanges, unevenBaseline} from '@/lib/allocation/planner';
import {availableCeilings} from '@/lib/allocation/model';
import {generatedNotes} from '@/lib/allocation/outcome';
import {compileAllocation, planAllocation} from '@/lib/allocation/compile';
import type {AllocationDraft, AllocationInput, Kind} from '@/lib/allocation/types';
import {createGenerationWorker} from '@/lib/scheduling/client';
import {inputKey, prepareGeneration} from '@/lib/scheduling/domain';
import {generationRotations} from '@/lib/scheduling/rotation';
import {publishedHistory} from '@/lib/supabase/snapshot';
import {addDays, dayOf} from '@/lib/rota/calendar-dates';
import {acceptGeneration, type GenerationResult} from '@/lib/scheduling/generate';
import type {Approval, GenerationInput} from '@/lib/scheduling/types';
import type {GenerationContext} from '@/lib/supabase/generation';
import {errorMessage} from '@/lib/supabase/rpc';
import type {Translate} from '@/components/rota/workspace-types';

type Phase = 'idle' | 'loading' | 'confirming' | 'generating' | 'saving';
/** Pair ids only need to be unique within one draft; crypto.randomUUID needs a secure context. */
let pairSerial = 0;
const pairId = () => `pair-${Date.now().toString(36)}-${(pairSerial++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
type Review = {draft: AllocationDraft; locks: NonNullable<GenerationInput['locks']>; approvals: Approval[]};
/** Failures that only a fresh proposal resolves: an earlier saved format, an
 * ordinary baseline the duties cannot split into, or uneven-month credit. */
const needsProposal = (message: string) => /invalid-ordinary-baseline|uneven-credit|invalid-allocation-(shape|changes|pair)|invalid-derived-transfers|invalid-hand-edits/.test(message);

export function useAllocationWorkflow(remote: TeamWorkspace, month: string, t: Translate) {
  const latest = useRef(remote);
  useEffect(() => {latest.current = remote;});
  const [open, setOpen] = useState(false), [phase, setPhase] = useState<Phase>('idle');
  const [captured, setCaptured] = useState<GenerationContext | null>(null), contextRef = useRef<GenerationContext | null>(null);
  const [draft, setDraft] = useState<AllocationDraft | null>(null);
  const [locks, setLocks] = useState<Review['locks']>([]), [approvals, setApprovals] = useState<Approval[]>([]);
  const [history, setHistory] = useState<Review[]>([]), [step, setStep] = useState(2);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [reviewed, setReviewed] = useState(false);
  const [closed, setClosed] = useState(false), [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);
  // The authoritative month could not be read; the primary action becomes Try again.
  const [retry, setRetry] = useState(false);
  // The draft the last Save stored; Save reads "Saved" until the next change.
  const [savedDraft, setSavedDraft] = useState<AllocationDraft | null>(null);
  // The latest manual drag transfer, offered once as "Make permanent".
  const [moved, setMoved] = useState<{id: string; fromId: string; toId: string} | null>(null);
  const sequence = useRef(0), worker = useRef<{terminate: () => void} | null>(null), rpc = useRef(false);
  const receivedAt = useRef(0), opening = useRef(false), draftRef = useRef<AllocationDraft | null>(null);
  const revision = remote.snapshot?.revision;
  function accept(context: GenerationContext) {
    contextRef.current = context; receivedAt.current = performance.now(); setCaptured(context);
    setClosed(!context.generationAllowed);
  }
  const now = () => generationNow(contextRef.current?.actualAtMs ?? Date.now(), receivedAt.current, performance.now());
  function stop() {sequence.current++; worker.current?.terminate(); worker.current = null;}
  function fail(e: unknown) {
    setError(errorMessage(e, t('Could not finish. Your saved draft is unchanged. Try again.', 'הפעולה לא הושלמה. הטיוטה השמורה נשמרה. אפשר לנסות שוב.')));
  }
  async function load() {
    if (rpc.current || !latest.current.isAdmin || latest.current.readOnly || latest.current.snapshot?.revision == null) return null;
    stop(); const id = sequence.current;
    setPhase('loading'); setError(''); rpc.current = true;
    try {
      const context = await latest.current.generationContext(month, latest.current.snapshot.revision);
      if (id !== sequence.current) return null;
      accept(context); setRetry(false); return context;
    } catch (e) {if (id === sequence.current) {fail(e); setRetry(true);} return null;}
    finally {rpc.current = false; if (id === sequence.current) setPhase('idle');}
  }
  useEffect(() => {
    contextRef.current = null; opening.current = false;
    queueMicrotask(() => {
      setCaptured(null); setDraft(null); setOpen(false); setResult(null);
      setHistory([]); setReviewed(false); setError(''); setRetry(false);
    });
    const lifecycle = sequence, active = worker;
    return () => {lifecycle.current++; active.current?.terminate();};
  }, [month]);
  useEffect(() => {
    if (!remote.isAdmin || remote.readOnly || remote.saving || revision == null || rpc.current || contextRef.current?.revision === revision) return;
    if (contextRef.current) {
      stop(); setReviewed(false); setResult(null);
      setHistory([]);
      // An open plan is reviewed again at once against the refreshed month.
      if (open) {
        void refresh('', t('Team data changed, so the month was refreshed. Your targets are kept; check them before confirming.', 'נתוני הצוות השתנו והחודש רוענן. היעדים נשמרו; כדאי לבדוק אותם לפני האישור.')); return;
      }
    }
    void load();
    // The accepted revision, rather than the render-created remote API, owns this read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, revision, remote.isAdmin, remote.readOnly, remote.saving]);
  useEffect(() => {
    if (!captured) return;
    const tick = () => {
      if (now() < captured.coverageStartMs) return;
      setClosed(true);
      if (!rpc.current && worker.current) {stop(); setPhase('idle'); setNotice(t('Coverage has started. Use manual assignments or swaps.', 'הכיסוי החודשי התחיל. יש לערוך שיבוצים ידנית או לבצע החלפות.'));}
    };
    tick(); const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captured]);

  const input = captured ? {...captured.input, schedule: {...captured.input.schedule, locks, approvals}} : null;
  const totals = input ? allocationTotals(input, draft, captured!.assignments) : null;
  // After Generate the plan is where the month is reviewed: scheduled vs planned, back-to-back days.
  // Keyed on the month flag: saving the plan clears the stored generation record, not the flag.
  const generatedMonth = !!remote.snapshot?.months.find(m => m.month === month)?.generated;
  const outcome = useMemo(() => captured && generatedMonth ? generatedNotes({...captured.input, schedule: {...captured.input.schedule, approvals}}, captured.assignments) : null,
    [captured, approvals, generatedMonth]);
  // Non-weekend members, and whether one still holds a weekend the manager locked
  // (kept, never deleted; the plan warns about it).
  const noWeekends = useMemo(() => Object.fromEntries((captured?.input.schedule.members ?? []).filter(m => m.noWeekends)
    .map(m => [m.id, {lockedWeekend: locks.some(l => l.engineer === m.id && [5, 6].includes(dayOf(l.dutyId)))}])), [captured, locks]);
  // Indivisible duties can make the ordinary baseline differ from an equal split.
  const uneven = draft && input ? unevenBaseline(input, draft.baselineUnits) : [];
  // Above the spaced ceiling a target still fits availability but needs back-to-back days.
  // Both ceilings are shown only in the open plan, so month browsing never builds them.
  const spaced = useMemo(() => {
    if (!captured || !open) return null;
    try {return allocationCeilings({...captured.input, schedule: {...captured.input.schedule, locks, approvals}});} catch {return null;}
  }, [captured, locks, approvals, open]);
  // Live simple check: a target above what availability allows warns on its row.
  const ceilings = useMemo(() => {
    if (!captured || !open) return null;
    try {return availableCeilings({...captured.input, schedule: {...captured.input.schedule, locks, approvals}});} catch {return null;}
  }, [captured, locks, approvals, open]);
  // Which + / − the library accepts at the current step: the dialog disables the rest,
  // so a + that no one can absorb never adds points the month does not have.
  const options = useMemo(() => {
    if (!captured || !draft?.changes) return null;
    try {return editOptions({...captured.input, schedule: {...captured.input.schedule, locks, approvals}}, draft, step);} catch {return null;}
  }, [captured, locks, approvals, draft, step]);
  let structural = '';
  // Every change kind must have found its counterpart: the hand total of each
  // kind is zero once the automatic balance has placed it.
  const unplaced = draft?.changes ? unplacedChanges(draft) : {temporary: 0, permanent: 0};
  if (draft && input) {
    try {
      prepareGeneration({...input.schedule, targets: Object.fromEntries(Object.entries(draft.targetsUnits).map(([id, u]) => [id, u / 2]))});
      // An unchanged copy of an earlier publication keeps its stored provenance;
      // the checked RPC revalidates it. Anything else needs the per-person shape.
      if (!draft.changes) {if (!captured?.sourcePublicationId) structural = t('This saved allocation uses an earlier format. Generation has closed, so it can’t be replaced with a new proposal.', 'ההקצאה השמורה נשמרה בפורמט ישן. השיבוץ האוטומטי נסגר ולכן לא ניתן להחליף אותה בהצעה חדשה.');}
      else if (!balanced(draft)) structural = t('Place the remaining points with the Temporary or Permanent controls.', 'יש לחלק את הנקודות שנותרו באמצעות בקרי השינוי הזמני או הקבוע.');
    } catch (e) {structural = errorMessage(e, 'Review allocation');}
  }
  // The plan as if every point were worked: what is really repaid now and later.
  let planned: ReturnType<typeof planAllocation> | null = null;
  if (draft?.changes && input && !structural) {try {planned = planAllocation(input, draft);} catch {planned = null;}}
  /** Proposal, review and edits are synchronous arithmetic; only Generate solves. */
  function plan(make: () => AllocationDraft) {
    setError('');
    try {const next = make(); setDraft(next); setReviewed(true); setMoved(null); return next;}
    catch (e) {fail(e); return null;}
  }
  // Copied publication intent keeps its stored provenance; the checked RPC revalidates it.
  const review = (i: AllocationInput, saved: AllocationDraft, copied: boolean) =>
    copied ? saved : reviewAllocation(i, saved);
  /** Reviews a saved or retained allocation. One that no longer fits (an earlier
   * format, a changed team, or a failure that needs fresh credit) is replaced by a
   * new proposal keeping the per-person changes that still fit, while generation
   * is open. `reason` is a failure the dialog already explains. */
  function adopt(c: GenerationContext, saved: AllocationDraft | null, copied: boolean, reason = '') {
    if (saved && !needsProposal(reason)) {
      try {
        const next = review(c.input, saved, copied);
        if (next.changes || copied || !c.generationAllowed) return plan(() => next);
      } catch (e) {if (!c.generationAllowed) {fail(e); return null;}}
    }
    if (!c.generationAllowed) return null;
    const next = plan(() => proposeAllocation(c.input, retainedChanges(saved)).draft);
    if (next && saved && !reason) setNotice(t('The saved allocation no longer fits this month, so a new proposal replaced it. Check it, then confirm.', 'ההקצאה השמורה אינה מתאימה עוד לחודש זה ולכן הוחלפה בהצעה חדשה. כדאי לבדוק ולאשר.'));
    return next;
  }
  /** Reads the month again and reviews the retained targets; no manual step. */
  async function refresh(reason = '', notice = '') {
    const old = draftRef.current, c = await load(); if (!c) return null;
    if (notice) setNotice(notice);
    setLocks(c.input.schedule.locks ?? []); setApprovals(c.input.schedule.approvals ?? []);
    const copied = !!c.sourcePublicationId && (!old || JSON.stringify(persistedDraft(old)) === JSON.stringify(c.allocation));
    return adopt(c, old ?? c.allocation, copied, reason);
  }
  async function show() {
    if (opening.current) return; opening.current = true;
    setOpen(true); setStep(2); setHistory([]); setMoved(null); setError(''); setNotice('');
    const c = contextRef.current ?? await load();
    opening.current = false;
    if (!c) return;
    setDraft(c.allocation); setReviewed(false);
    setLocks(c.input.schedule.locks ?? []); setApprovals(c.input.schedule.approvals ?? []);
    adopt(c, c.allocation, !!c.sourcePublicationId);
    if (!schedulingSupported()) setError(unsupported());
  }
  const unsupported = () => t('This browser cannot run the planner. Use a current browser with WebAssembly and Workers.', 'הדפדפן אינו תומך במתכנן. יש להשתמש בדפדפן עדכני שתומך ב־WebAssembly וב־Workers.');
  function edit(engineer: string, deltaUnits: number, kind: Kind) {
    if (!input || !draft || phase !== 'idle') return;
    const previous = {draft, locks, approvals};
    if (plan(() => editAllocation(input, draft, {engineer, deltaUnits, kind}).draft)) {
      setHistory(h => [...h, previous]); setNotice(t('Points updated. Counterpart changes are shown below.', 'הנקודות עודכנו. השינויים אצל המהנדסים האחרים מוצגים בהמשך.'));
    }
  }
  /** Exact manual transfer of one point; temporary until made permanent. */
  function transfer(fromId: string, toId: string) {
    if (!input || !draft || phase !== 'idle' || fromId === toId) return;
    const previous = {draft, locks, approvals}, id = pairId();
    if (plan(() => transferAllocation(input, draft, {id, fromId, toId, units: 2, kind: 'temporary'}).draft)) {
      setHistory(h => [...h, previous]); setMoved({id, fromId, toId}); setNotice('');
    }
  }
  function makePermanent() {
    if (!input || !draft || !moved || phase !== 'idle') return;
    try {
      const next = classifyTransfer(input, draft, moved.id, 'permanent');
      setHistory(h => [...h, {draft, locks, approvals}]); setDraft(next); setMoved(null);
      setNotice(t('Transfer made permanent.', 'ההעברה הפכה לקבועה.'));
    } catch (e) {fail(e);}
  }
  function undo() {
    stop(); setPhase('idle'); const previous = history.at(-1); if (!previous) return;
    setDraft(previous.draft); setLocks(previous.locks); setApprovals(previous.approvals);
    setHistory(h => h.slice(0, -1)); setMoved(null); setReviewed(true); setError(''); setNotice(t('Last change undone.', 'השינוי האחרון בוטל.'));
  }
  async function confirm(generate = true) {
    if (!captured || !draft || !input || structural || !reviewed || phase !== 'idle' || rpc.current) return;
    if (generate && now() >= captured.coverageStartMs) {setClosed(true); return;}
    if (generate && !schedulingSupported()) {setError(unsupported()); return;}
    stop(); const id = sequence.current;
    setError(''); setProgress(null); setPhase('confirming'); rpc.current = true;
    let failure: unknown = null;
    try {
      let source = captured;
      if (!latest.current.snapshot?.months.some(m => m.month === month)) {
        const state = latest.current.state!;
        source = await latest.current.openGenerationMonth(captured, {...state, months: {...state.months,
          [month]: {deadline: addDays(month + '-01', -7), status: 'draft', generated: false}}});
        const comparable = (c: GenerationContext) => inputKey({...c.input.schedule, sourceRevision: undefined});
        if (comparable(source) !== comparable(captured) || source.accountingFingerprint !== captured.accountingFingerprint) throw Error('Generation inputs changed. Refresh and review.');
      }
      const confirmed = await latest.current.confirmAllocation(source, draft, locks, approvals);
      if (id !== sequence.current) return;
      accept(confirmed); rpc.current = false;
      if (!generate) {
        // The checked save moves the month to a new revision: review the plan against it,
        // as reopening would, so later edits and the adjustments list stay current.
        // Undo steps from before the save belong to the old revision.
        let next = draft;
        try {next = review(confirmed.input, draft, !!confirmed.sourcePublicationId);} catch {/* the checked save accepted it; reopening reviews it again */}
        setDraft(next); setSavedDraft(next); setHistory([]);
        setNotice(t('Saved. Close any time and continue from here later.', 'נשמר. אפשר לסגור ולהמשיך מכאן מאוחר יותר.')); return;
      }
      if (!confirmed.generationInput || now() >= confirmed.coverageStartMs) throw Error('generation-window-closed');
      setPhase('generating');
      // Weekend and weekday rotation state comes from the published months the workspace
      // already holds; both are soft objectives, so the checked save does not revalidate them.
      // Non-weekend members are left out of the weekend rotation (see generationRotations).
      const history = latest.current.snapshot ? publishedHistory(latest.current.snapshot, month) : [];
      const generationInput: GenerationInput = {...confirmed.generationInput,
        ...generationRotations(history, confirmed.generationInput.members, month)};
      const active = createGenerationWorker(now); worker.current = active;
      let generated: GenerationResult;
      try {
        generated = await active.run(generationInput, {seconds: 30}, p => {
          if (id === sequence.current) setProgress(p.metrics.coverage);
        });
      } catch (e) {
        // Cancellation, Worker loading and stale or closed windows keep their own messages.
        // Anything else is an internal solver/validation failure: the detail goes to the console.
        if (/Worker|WASM|fetch|load failed|stale|window-closed/i.test(errorMessage(e, ''))) throw e;
        console.error('Generate failed', e);
        throw Error(t('Generate couldn’t finish. Try again, or adjust the plan.', 'השיבוץ לא הושלם. אפשר לנסות שוב או לשנות את התוכנית.'));
      }
      active.terminate(); worker.current = null;
      if (id !== sequence.current) return;
      acceptGeneration(generated, generationInput, now());
      // Compile against the actual returned assignments, never the allocation witness.
      // Copied publication intent is independently revalidated by the checked RPC.
      if (!confirmed.sourcePublicationId &&
        !compileAllocation(confirmed.input, reviewAllocation(confirmed.input, draft), generated.assignments).confirmable) {
        throw Error(t('This plan can’t be booked as it is. Check the notes in the plan, then try again.', 'לא ניתן לרשום את התוכנית כפי שהיא. כדאי לבדוק את ההערות בתוכנית ולנסות שוב.'));
      }
      if (id !== sequence.current) return;
      acceptGeneration(generated, generationInput, now());
      setPhase('saving'); rpc.current = true;
      const saved = await latest.current.saveGeneration(confirmed, generated.assignments, generated.reproduction.settings.seed);
      if (id !== sequence.current) return;
      accept(saved); setResult(generated); setOpen(false); setNotice('');
      // The plan is where the result is reviewed: the toast leads there.
      toast.success(generated.complete ? t('Draft ready. Review it in Plan the month.', 'הטיוטה מוכנה. אפשר לבדוק אותה בתכנון החודש.') : t('Partial draft saved. Review it in Plan the month.', 'טיוטה חלקית נשמרה. אפשר לבדוק אותה בתכנון החודש.'),
        {action: {label: t('Review', 'בדיקה'), onClick: () => {void show();}}});
    } catch (e) {if (id === sequence.current) {failure = e; setReviewed(false);}}
    finally {
      rpc.current = false;
      if (id === sequence.current) {worker.current?.terminate(); worker.current = null; setPhase('idle');}
    }
    // Never retry the failed write: read the month again, review the retained
    // targets (or a new proposal when only that resolves it), then explain.
    if (failure) {
      if (await refresh(errorMessage(failure, ''))) fail(failure);
    }
  }
  function cancel() {
    if (rpc.current) return;
    stop(); setPhase('idle'); setNotice(t('Cancelled. Your saved draft is unchanged.', 'הפעולה בוטלה. הטיוטה השמורה לא השתנתה.')); setError('');
  }
  useEffect(() => {draftRef.current = draft;});
  return {open, show, close: () => {if (!rpc.current) {cancel(); setOpen(false);}}, phase, captured, input, draft, ceilings, spaced, outcome, options,
    locks, approvals, totals, uneven, noWeekends, planned, unplaced, step, setStep, error, notice, structural, closed, progress, result, reviewed,
    history, undo, edit, transfer, moved, makePermanent, dismissMoved: () => setMoved(null), confirm, cancel,
    retry: retry && phase === 'idle', refresh: () => {void refresh();},
    busy: phase !== 'idle', saving: phase === 'confirming' || phase === 'saving',
    canConfirm: !!draft && reviewed && !structural && phase === 'idle', saved: !!draft && draft === savedDraft,
  };
}
export type AllocationWorkflow = ReturnType<typeof useAllocationWorkflow>;
