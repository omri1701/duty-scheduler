'use client';
import {Toaster} from 'sonner';
import {useTheme} from '@/hooks/use-theme';

/** Short toasts at the bottom, above the phone tab bar, in the current theme. */
export function AppToaster() {
  const {theme} = useTheme();
  return <Toaster position="bottom-center" theme={theme} richColors duration={3200} gap={8} swipeDirections={['left', 'right', 'bottom']} toastOptions={{className: 'toast'}}/>;
}
