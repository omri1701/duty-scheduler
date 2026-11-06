// This device's web push subscription (the settings screen's "Enable notifications").
// iPhone receives Web Push only from a Home Screen app (iOS 16.4+); Android Chrome and
// desktop browsers receive it in the browser.
import {base64url, supportedPushEndpoint, vapidKeyBytes} from './endpoint.ts';

/** install: iPhone/iPad in Safari, Add to Home Screen first. off/on: this device. */
export type PushStatus = 'unsupported' | 'install' | 'blocked' | 'unconfigured' | 'off' | 'on';
export type DeviceSubscription = {endpoint: string; p256dh: string; auth: string};

export function isAppleMobile(nav: Navigator = navigator) {
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}
export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & {standalone?: boolean}).standalone === true;
}
const capable = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function registration() {
  return navigator.serviceWorker.getRegistration('/');
}
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!capable()) return null;
  return (await (await registration())?.pushManager.getSubscription()) ?? null;
}

export async function pushStatus(vapidKey: string | null): Promise<PushStatus> {
  if (!capable()) return isAppleMobile() && !isStandalone() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (!vapidKey) return 'unconfigured';
  const subscription = Notification.permission === 'granted' ? await currentSubscription() : null;
  return subscription && supportedPushEndpoint(subscription.endpoint) ? 'on' : 'off';
}

export function describe(subscription: PushSubscription): DeviceSubscription {
  return {endpoint: subscription.endpoint, p256dh: base64url(subscription.getKey('p256dh')), auth: base64url(subscription.getKey('auth'))};
}

const sameKey = (subscription: PushSubscription, key: Uint8Array) => {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
};

/** Asks for permission (call straight from the click), subscribes and saves this device. */
export async function enablePush(vapidKey: string, save: (device: DeviceSubscription) => Promise<void>) {
  if (!capable()) throw Error(isAppleMobile() && !isStandalone() ? 'push-install-first' : 'push-unsupported');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw Error('push-permission-denied');
  const key = vapidKeyBytes(vapidKey);
  let subscription: PushSubscription;
  try {
    const worker = await navigator.serviceWorker.register('/sw.js', {scope: '/'});
    await navigator.serviceWorker.ready;
    const existing = await worker.pushManager.getSubscription();
    // A rotated server key needs a fresh subscription.
    if (existing && !sameKey(existing, key)) await existing.unsubscribe();
    subscription = existing && sameKey(existing, key) ? existing : await worker.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key});
  } catch {throw Error('push-subscribe-failed');}
  if (!supportedPushEndpoint(subscription.endpoint)) {
    await subscription.unsubscribe().catch(() => false);
    throw Error('push-service-unsupported');
  }
  await save(describe(subscription));
}

/** Turns this device off: the server forgets it, then the browser unsubscribes. */
export async function disablePush(remove: (endpoint: string) => Promise<void>) {
  const subscription = await currentSubscription();
  if (!subscription) return;
  // The browser stops receiving even if the server can't be told; the push service's
  // 410 then removes the server's copy on the next send.
  try {await remove(subscription.endpoint);}
  finally {await subscription.unsubscribe().catch(() => false);}
}

/** Signing out on this device: best effort, never blocks sign-out. */
export async function forgetDevice(remove: (endpoint: string) => Promise<void>, timeoutMs = 3000) {
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;
  try {
    await Promise.race([remove(subscription.endpoint), new Promise(resolve => setTimeout(resolve, timeoutMs))]);
  } catch {}
  finally {await subscription.unsubscribe().catch(() => false);}
}
