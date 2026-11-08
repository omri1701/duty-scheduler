'use client';
import type {ReactNode} from 'react';
import {Sheet, type SheetProps} from '@/components/ui/sheet';

/** Every editor (duty, published duty, availability, plan) is one Sheet: a bottom sheet on
 * phones, a panel on PC. Dismissal is blocked while a save runs; focus returns to the caller. */
export function EditorDialog({open = true, onClose, saving = false, lang, title, description, children, className = '', onCloseAutoFocus, role = 'dialog', kind = 'sheet', desktop = 'panel', size = 'md', footer, tools}: {
  open?: boolean; onClose: () => void; saving?: boolean; lang: 'en' | 'he'; title: ReactNode; description?: ReactNode; children: ReactNode; className?: string;
  onCloseAutoFocus?: (event: Event) => void; role?: 'dialog' | 'alertdialog'; kind?: SheetProps['kind']; desktop?: SheetProps['desktop']; size?: SheetProps['size']; footer?: ReactNode; tools?: ReactNode;
}) {
  return <Sheet open={open} onOpenChange={value => {if (!value && !saving) onClose();}} title={title} description={description} lang={lang} role={role} kind={kind} desktop={desktop} size={size}
    className={`editor-dialog ${className}`} closeDisabled={saving} busy={saving} footer={footer} tools={tools} onCloseAutoFocus={onCloseAutoFocus}>
    {children}
  </Sheet>;
}
