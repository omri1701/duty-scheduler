'use client';
import {useRef, type ComponentProps, type ReactNode} from 'react';
import {Drawer} from 'vaul';
import {Dialog as DialogPrimitive} from 'radix-ui';
import {ChevronLeft, X} from 'lucide-react';
import {useMobileLayout} from '@/hooks/use-mobile-layout';
import {cn} from '@/lib/utils';

type ContentEvents = Pick<ComponentProps<typeof DialogPrimitive.Content>, 'onOpenAutoFocus' | 'onCloseAutoFocus' | 'onEscapeKeyDown' | 'onPointerDownOutside' | 'onInteractOutside'>;

export type SheetProps = ContentEvents & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Sticky actions under the body (safe-area aware on phones). */
  footer?: ReactNode;
  /** `alert`: a small centred dialog everywhere (confirmations). `sheet`: a bottom sheet on
   * phones, a side panel or a centred window on PC. `page`: a full screen that slides in on
   * phones and closes with an edge swipe or its back button; a panel on PC. */
  kind?: 'sheet' | 'alert' | 'page';
  desktop?: 'panel' | 'center';
  size?: 'md' | 'lg';
  /** Keeps the sheet open (no close button, Escape or outside tap) while a save runs. */
  closeDisabled?: boolean;
  busy?: boolean;
  role?: 'dialog' | 'alertdialog';
  lang: 'en' | 'he';
  className?: string;
  /** Extra controls beside the close button. */
  tools?: ReactNode;
  id?: string;
};

/** The one modal surface of the app (decision 2026-11-06): bottom sheets that close with a
 * swipe down on phones, panels on PC, the same header, body and footer everywhere. */
export function Sheet({open, onOpenChange, title, description, children, footer, kind = 'sheet', desktop = 'panel', size = 'md', closeDisabled = false, busy = false,
  role = 'dialog', lang, className, tools, id, onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, onPointerDownOutside, onInteractOutside}: SheetProps) {
  const mobile = useMobileLayout();
  const dir = lang === 'he' ? 'rtl' : 'ltr';
  const returnFocus = useRef<HTMLElement | null>(null);
  const t = (en: string, he: string) => lang === 'he' ? he : en;
  const change = (next: boolean) => {if (next || !closeDisabled) onOpenChange(next);};
  const events: ContentEvents = {
    onOpenAutoFocus: event => {returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; onOpenAutoFocus?.(event);},
    onCloseAutoFocus: event => {
      if (onCloseAutoFocus) {onCloseAutoFocus(event); return;}
      event.preventDefault();
      if (returnFocus.current?.isConnected) returnFocus.current.focus({preventScroll: true});
    },
    onEscapeKeyDown: event => {if (closeDisabled) event.preventDefault(); onEscapeKeyDown?.(event);},
    onPointerDownOutside: event => {if (closeDisabled) event.preventDefault(); onPointerDownOutside?.(event);},
    onInteractOutside: event => {if (closeDisabled) event.preventDefault(); onInteractOutside?.(event);},
  };
  const head = (Title: typeof DialogPrimitive.Title, Description: typeof DialogPrimitive.Description, Close: typeof DialogPrimitive.Close) => <header className="sheet-head">
    <div className="sheet-heading">
      <Title className="sheet-title">{title}</Title>
      {description ? <Description className="sheet-description">{description}</Description> : <Description className="sr-only">{typeof title === 'string' ? title : ''}</Description>}
    </div>
    <div className="sheet-tools">
      {tools}
      <Close className="sheet-close" disabled={closeDisabled} aria-label={t('Close', 'סגירה')}><X aria-hidden="true"/></Close>
    </div>
  </header>;
  const body = <div className="sheet-body">{children}</div>;
  const foot = footer ? <footer className="sheet-foot">{footer}</footer> : null;
  const classes = cn('sheet', `sheet-${size}`, className);

  if (mobile && kind === 'sheet') {
    return <Drawer.Root open={open} onOpenChange={change} dismissible={!closeDisabled} shouldScaleBackground={false} direction="bottom">
      <Drawer.Portal>
        <Drawer.Overlay className="sheet-overlay"/>
        <Drawer.Content id={id} dir={dir} role={role} aria-busy={busy || undefined} className={cn(classes, 'sheet-bottom')} {...events}>
          <Drawer.Handle className="sheet-handle" aria-hidden="true"/>
          {head(Drawer.Title, Drawer.Description, Drawer.Close)}
          {body}
          {foot}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>;
  }
  const page = mobile && kind === 'page';
  const placement = page ? 'sheet-page' : kind === 'alert' ? 'sheet-alert' : desktop === 'panel' ? 'sheet-panel' : 'sheet-center';
  return <DialogPrimitive.Root open={open} onOpenChange={change}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sheet-overlay"/>
      <DialogPrimitive.Content id={id} dir={dir} role={role} aria-busy={busy || undefined} className={cn(classes, placement)} {...events} {...(page ? edgeSwipe(() => change(false), dir === 'rtl') : {})}>
        {page ? <header className="sheet-head sheet-page-head">
          <DialogPrimitive.Close className="sheet-back" disabled={closeDisabled} aria-label={t('Back', 'חזרה')}><ChevronLeft aria-hidden="true" className="rtl-flip"/></DialogPrimitive.Close>
          <div className="sheet-heading"><DialogPrimitive.Title className="sheet-title">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className={description ? 'sheet-description' : 'sr-only'}>{description ?? (typeof title === 'string' ? title : '')}</DialogPrimitive.Description></div>
          <div className="sheet-tools">{tools}</div>
        </header> : head(DialogPrimitive.Title, DialogPrimitive.Description, DialogPrimitive.Close)}
        {body}
        {foot}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

/** A swipe from the leading edge closes a page, like a native back gesture. */
function edgeSwipe(close: () => void, rtl: boolean) {
  let start: {x: number; y: number; id: number} | null = null;
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'touch' || !e.isPrimary) return;
      const width = e.currentTarget.clientWidth, fromEdge = rtl ? width - e.clientX : e.clientX;
      start = fromEdge <= 28 ? {x: e.clientX, y: e.clientY, id: e.pointerId} : null;
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      const s = start; start = null;
      if (!s || s.id !== e.pointerId) return;
      const dx = (e.clientX - s.x) * (rtl ? -1 : 1), dy = Math.abs(e.clientY - s.y);
      if (dx > 70 && dx > dy * 1.5) close();
    },
    onPointerCancel: () => {start = null;},
  };
}
