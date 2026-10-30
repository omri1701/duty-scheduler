'use client';
import {useEffect, useMemo, useRef, useState} from 'react';
import {toast} from 'sonner';
import type {TeamWorkspace} from './use-team-workspace';
import {generationNow, schedulingSupported} from '@/lib/allocation/client';
import {allocationTotals, reviewAllocation} from '@/lib/allocation/review';
import {classifyTransfer, editAllocation, persistedDraft, transferAllocation} from '@/lib/allocation/edits';
import {allocationCeilings, proposeAllocation, unevenBaseline} from '@/lib/allocation/planner';
import {compileAllocation} from '@/lib/allocation/compile';
import type {AllocationDraft, AllocationInput, Kind} from '@/lib/allocation/types';
import {createGenerationWorker} from '@/lib/scheduling/client';
import {inputKey, prepareGeneration} from '@/lib/scheduling/domain';
import {addDays} from '@/lib/rota/calendar-dates';
import {acceptGeneration, type GenerationResult} from '@/lib/scheduling/generate';
import type {Approval, GenerationInput} from '@/lib/scheduling/types';
import type {GenerationContext} from '@/lib/supabase/generation';
import {errorMessage} from '@/lib/supabase/rpc';
import type {Translate} from '@/components/rota/workspace-types';

type Phase = 'idle' | 'loading' | 'confirming' | 'generating' | 'saving';
type Review = {draft: AllocationDraft; locks: NonNullable<GenerationInput['locks']>; approvals: Approval[]};

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
  // The latest manual drag transfer, offered once as "Make permanent".
  const [moved, setMoved] = useState<{id: string; fromId: string; toId: string} | null>(null);
  const sequence = useRef(0), worker = useRef<{terminate: () => void} | null>(null), rpc = useRef(false);
  const receivedAt = useRef(0), opening = useRef(false);
  const revision = remote.snapshot?.revision;
  function accept(context: GenerationContext) {
    contextRef.current = context; receivedAt.current = performance.now(); setCaptured(context);
    setClosed(!context.generationAllowed);
  }
  const now = () => generationNow(contextRef.current?.actualAtMs ?? Date.now(), receivedAt.current, performance.now());
  function stop() {sequence.current++; worker.current?.terminate(); worker.current = null;}
  function fail(e: unknown) {
    setError(errorMessage(e, t('Could not finish. Your saved draft is unchanged. Retry or refresh and review.', 'הפעולה לא הושלמה. הטיוטה השמורה נשמרה. אפשר לנסות שוב או לרענן ולבדוק.')));
  }
  async function load() {
    if (rpc.current || !latest.current.isAdmin || latest.current.readOnly || latest.current.snapshot?.revision == null) return null;
    stop(); const id = sequence.current;
    setPhase('loading'); setError(''); rpc.current = true;
    try {
      const context = await latest.current.generationContext(month, latest.current.snapshot.revision);
      if (id !== sequence.current) return null;
      accept(context); return context;
    } catch (e) {if (id === sequence.current) fail(e); return null;}
    finally {rpc.current = false; if (id === sequence.current) setPhase('idle');}
  }
  useEffect(() => {
    contextRef.current = null; opening.current = false;
    queueMicrotask(() => {
      setCaptured(null); setDraft(null); setOpen(false); setResult(null);
      setHistory([]); setReviewed(false); setError('');
    });
    const lifecycle = sequence, active = worker;
    return () => {lifecycle.current++; active.current?.terminate();};
  }, [month]);
  useEffect(() => {
    if (!remote.isAdmin || remote.readOnly || remote.saving || revision == null || rpc.current || contextRef.current?.revision === revision) return;
    if (contextRef.current) {
      stop(); setReviewed(false); setResult(null);
      setHistory([]);
      setNotice(t('Team data changed. Review your retained targets against the refreshed month.', 'נתוני הצוות השתנו. יש לבדוק את היעדים שנשמרו מול החודש המעודכן.'));
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
  // Indivisible duties can make the ordinary baseline differ from an equal split.
  const uneven = draft && input ? unevenBaseline(input, draft.baselineUnits) : [];
  // Live simple check: a target above what availability allows warns on its row.
  const ceilings = useMemo(() => {
    if (!captured) return null;
    try {return allocationCeilings({...captured.input, schedule: {...captured.input.schedule, locks, approvals}});} catch {return null;}
  }, [captured, locks, approvals]);
  let structural = '';
  if (draft && input) {
    try {
      prepareGeneration({...input.schedule, targets: Object.fromEntries(Object.entries(draft.targetsUnits).map(([id, u]) => [id, u / 2]))});
      if (draft.pending.length) structural = t('Finish the pending redistribution using Target or Permanent controls.', 'יש להשלים את החלוקה הממתינה באמצעות בקרי היעד או השינוי הקבוע.');
    } catch (e) {structural = errorMessage(e, 'Review allocation');}
  }
  /** Proposal, review and edits are synchronous arithmetic; only Generate solves. */
  function plan(make: () => AllocationDraft) {
    setError('');
    try {const next = make(); setDraft(next); setReviewed(true); setMoved(null); return next;}
    catch (e) {fail(e); return null;}
  }
  // Copied publication intent keeps its stored provenance; the checked RPC revalidates it.
  const review = (i: AllocationInput, saved: AllocationDraft, copied: boolean) =>
    copied ? saved : reviewAllocation(i, saved);
  async function show() {
    if (opening.current) return; opening.current = true;
    setOpen(true); setStep(2); setHistory([]); setMoved(null); setError(''); setNotice('');
    const c = contextRef.current ?? await load();
    opening.current = false;
    if (!c) return;
    setDraft(c.allocation); setReviewed(false);
    setLocks(c.input.schedule.locks ?? []); setApprovals(c.input.schedule.approvals ?? []);
    if (c.allocation) plan(() => review(c.input, c.allocation!, !!c.sourcePublicationId));
    else if (c.generationAllowed) plan(() => proposeAllocation(c.input).draft);
    if (!schedulingSupported()) setError(unsupported());
  }
  const unsupported = () => t('This browser cannot run the planner. Use a current browser with WebAssembly and Workers.', 'הדפדפן אינו תומך במתכנן. יש להשתמש בדפדפן עדכני שתומך ב־WebAssembly וב־Workers.');
  function remember() {if (draft) setHistory(h => [...h, {draft, locks, approvals}]);}
  function edit(engineer: string, deltaUnits: number, kind: Kind) {
    if (!input || !draft || phase !== 'idle') return;
    const previous = {draft, locks, approvals};
    if (plan(() => editAllocation(input, draft, {id: crypto.randomUUID(), engineer, deltaUnits, kind}).draft)) {
      setHistory(h => [...h, previous]); setNotice(t('Targets updated. Counterpart changes are shown below.', 'היעדים עודכנו. השינויים אצל המהנדסים האחרים מוצגים בהמשך.'));
    }
  }
  /** Exact manual transfer of one point; temporary until made permanent. */
  function transfer(fromId: string, toId: string) {
    if (!input || !draft || phase !== 'idle' || fromId === toId) return;
    const previous = {draft, locks, approvals}, id = `${crypto.randomUUID()}/0`;
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
  async function refreshReview() {
    const old = draft, c = await load(); if (!c) return;
    setLocks(c.input.schedule.locks ?? []); setApprovals(c.input.schedule.approvals ?? []);
    if (old) plan(() => review(c.input, old, !!c.sourcePublicationId && JSON.stringify(persistedDraft(old)) === JSON.stringify(c.allocation)));
    else if (c.allocation) plan(() => review(c.input, c.allocation!, !!c.sourcePublicationId));
    else plan(() => proposeAllocation(c.input).draft);
  }
  async function confirm(generate = true) {
    if (!captured || !draft || !input || structural || !reviewed || phase !== 'idle' || rpc.current) return;
    if (generate && now() >= captured.coverageStartMs) {setClosed(true); return;}
    if (generate && !schedulingSupported()) {setError(unsupported()); return;}
    stop(); const id = sequence.current;
    setError(''); setProgress(null); setPhase('confirming'); rpc.current = true;
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
      if (!generate) {setNotice(t('Allocation and locks saved.', 'ההקצאה והנעילות נשמרו.')); return;}
      if (!confirmed.generationInput || now() >= confirmed.coverageStartMs) throw Error('generation-window-closed');
      setPhase('generating');
      const active = createGenerationWorker(now); worker.current = active;
      const generated = await active.run(confirmed.generationInput, {seconds: 30}, p => {
        if (id === sequence.current) setProgress(p.metrics.coverage);
      });
      active.terminate(); worker.current = null;
      if (id !== sequence.current) return;
      acceptGeneration(generated, confirmed.generationInput, now());
      // Compile against the actual returned assignments, never the allocation witness.
      // Copied publication intent is independently revalidated by the checked RPC.
      if (!confirmed.sourcePublicationId &&
        !compileAllocation(confirmed.input, reviewAllocation(confirmed.input, draft), generated.assignments).confirmable) {
        throw Error('Allocation requires review before saving.');
      }
      if (id !== sequence.current) return;
      acceptGeneration(generated, confirmed.generationInput, now());
      setPhase('saving'); rpc.current = true;
      const saved = await latest.current.saveGeneration(confirmed, generated.assignments, generated.reproduction.settings.seed);
      if (id !== sequence.current) return;
      accept(saved); setResult(generated); setOpen(false); setNotice('');
      toast.success(generated.complete ? t('Draft ready. Review, then publish.', 'הטיוטה מוכנה לבדיקה ולפרסום.') : t('Partial draft saved. Review uncovered dates.', 'טיוטה חלקית נשמרה. יש לבדוק את התאריכים ללא כיסוי.'));
    } catch (e) {if (id === sequence.current) {fail(e); setNotice(t('Your saved assignments are retained. Refresh and review before retrying.', 'השיבוצים השמורים נשמרו. יש לרענן ולבדוק לפני ניסיון נוסף.')); setReviewed(false);}}
    finally {
      rpc.current = false;
      if (id === sequence.current) {worker.current?.terminate(); worker.current = null; setPhase('idle');}
    }
  }
  function cancel() {
    if (rpc.current) return;
    stop(); setPhase('idle'); setNotice(t('Cancelled. Your saved draft is unchanged.', 'הפעולה בוטלה. הטיוטה השמורה לא השתנתה.')); setError('');
  }
  return {open, show, close: () => {if (!rpc.current) {cancel(); setOpen(false);}}, phase, captured, input, draft, ceilings,
    locks, approvals, totals, uneven, step, setStep, error, notice, structural, closed, progress, result, reviewed,
    history, undo, edit, transfer, moved, makePermanent, dismissMoved: () => setMoved(null), refreshReview, confirm, cancel,
    propose: () => {if (input && phase === 'idle') {remember(); plan(() => proposeAllocation(input).draft);}},
    busy: phase !== 'idle', saving: phase === 'confirming' || phase === 'saving',
    canConfirm: !!draft && reviewed && !structural && phase === 'idle',
  };
}
export type AllocationWorkflow = ReturnType<typeof useAllocationWorkflow>;
