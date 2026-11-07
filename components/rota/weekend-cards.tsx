'use client';
import {useState,type ReactNode} from 'react';
import {Button} from '@/components/ui/button';
import {Chip} from '@/components/ui/chip';
import {Avatar} from '@/components/ui/avatar';
import {Segmented} from '@/components/ui/segmented';

export type Half='fri'|'sat';
/** How an editor shows a weekend (decision 2026-11-07): one card, two day cards, or one half of a
 * split weekend (a regular day card with a Join row). The draft and published editors share it. */
export type WeekendMode='one'|'two'|'half';

/** The layout state of the "One weekend | Two days" editor: which cards show, whether joining
 * asks who keeps the weekend, and keys that replay the split and join entrances. */
export function useWeekendLayout(initial:WeekendMode){
 const [mode,setMode]=useState<WeekendMode>(initial),[choosing,setChoosing]=useState(false);
 // Bumped on each split or join so the incoming card replays its entrance.
 const [splitKey,setSplitKey]=useState(0),[joinKey,setJoinKey]=useState(0);
 return {mode,choosing,splitKey,joinKey,
  split(){setChoosing(false);setMode('two');setSplitKey(k=>k+1)},
  /** Back to one weekend: the same person just joins; different people choose who keeps it. */
  join(same:boolean){setChoosing(!same);setMode('one');setJoinKey(k=>k+1)},
  kept(){setChoosing(false)}};
}
export type WeekendLayout=ReturnType<typeof useWeekendLayout>;

const text=(lang:'en'|'he')=>(en:string,he:string)=>lang==='en'?en:he;

/** "One weekend | Two days". */
export function WeekendLayoutSwitch({lang,layout,disabled,onChange}:{lang:'en'|'he';layout:WeekendLayout;disabled?:boolean;onChange:(next:'one'|'two')=>void}){
 const t=text(lang);
 return <Segmented label={t('Weekend layout','מבנה סוף השבוע')} value={layout.mode==='two'?'two':'one'} onChange={onChange} disabled={disabled} className="weekend-layout"
  options={[{value:'one',label:t('One weekend','סוף שבוע אחד')},{value:'two',label:t('Two days','שני ימים')}]}/>;
}

/** A half's sheet: "Part of a split weekend · Join". */
export function SplitJoinRow({lang,disabled,onJoin}:{lang:'en'|'he';disabled?:boolean;onJoin:()=>void}){
 const t=text(lang);
 return <div className="split-row"><span>{t('Part of a split weekend','חלק מסוף שבוע מפוצל')}</span><Button size="sm" variant="secondary" disabled={disabled} onClick={onJoin}>{t('Join','איחוד')}</Button></div>;
}

/** A regular day's card: a heading with an optional action (a lock), then its fields. */
export function DayCard({half,heading,action,className='',children}:{half:Half|'both';heading:ReactNode;action?:ReactNode;className?:string;children:ReactNode}){
 return <section className={`day-card ${className}`} data-half={half}>
  <div className="day-card-head">{heading}{action}</div>
  {children}
 </section>;
}

export function DayHeading({children,points}:{children:ReactNode;points?:string}){
 return <span className="day-card-title">{children}{points&&<Chip size="sm">{points}</Chip>}</span>;
}

/** Joining different people: "Keep X / Keep Y", each saying what the other gives up. */
export function KeepChoice({lang,disabled,options,onKeep}:{lang:'en'|'he';disabled?:boolean;options:{half:Half;person?:{name:string;color:string};title:string;detail:string}[];onKeep:(half:Half)=>void}){
 const t=text(lang);
 return <div className="keep-choice" role="group" aria-label={t('Who keeps the weekend','מי נשאר בסוף השבוע')}>
  {options.map(o=><button key={o.half} type="button" className="keep-option" disabled={disabled} onClick={()=>onKeep(o.half)}>
   {o.person?<Avatar name={o.person.name} color={o.person.color} size={32}/>:<span className="avatar avatar-empty" aria-hidden="true">—</span>}
   <span><strong>{o.title}</strong><small dir="auto">{o.detail}</small></span>
  </button>)}
 </div>;
}

/** The cards for the current layout; the second day card and the joined card animate in. */
export function DayCards({layout,weekend,focus,card}:{layout:WeekendLayout;weekend:boolean;focus:Half;card:(half:Half|'both')=>ReactNode}){
 const {mode,joinKey,splitKey}=layout;
 return <div className="day-cards" data-mode={mode}>
  {!weekend?card('fri'):mode==='one'?<div key={joinKey} className={joinKey?'card-join-in':''}>{card('both')}</div>:mode==='half'?card(focus):<>
   {card('fri')}
   <div key={splitKey} className="card-split-in">{card('sat')}</div>
  </>}
 </div>;
}
