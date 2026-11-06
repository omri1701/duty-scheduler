import type {Page} from '@playwright/test';

// A stand-in for the browser's Notification, PushManager and service worker
// (Playwright blocks real service workers). It records what the app asked for.
export type PushMock = {permission?: NotificationPermission; answer?: NotificationPermission; subscribed?: boolean; iphoneSafari?: boolean;
  endpoint?: string};
export const VAPID_PUBLIC_KEY = 'B' + 'A'.repeat(86);
export const SYNTHETIC_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/synthetic-device';

export async function mockPush(page: Page, options: PushMock = {}) {
  await page.addInitScript(({permission = 'default', answer = 'granted', subscribed = false, iphoneSafari = false, endpoint}) => {
    type State = {permission: NotificationPermission; requested: number; registered: number; subscribed: number; unsubscribed: number; subscription: unknown};
    const state: State = {permission, requested: 0, registered: 0, subscribed: 0, unsubscribed: 0, subscription: null};
    (window as unknown as {__push: State}).__push = state;
    if (iphoneSafari) {
      // iPhone Safari outside the Home Screen: no Push API at all.
      Object.defineProperty(navigator, 'userAgent', {value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'});
      delete (window as unknown as {PushManager?: unknown}).PushManager;
      return;
    }
    const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill).buffer;
    const subscription = (key: ArrayBuffer | null) => ({
      endpoint: endpoint ?? 'https://fcm.googleapis.com/fcm/send/synthetic-device', options: {applicationServerKey: key},
      getKey: (name: string) => name === 'p256dh' ? bytes(65, 4) : bytes(16, 7),
      unsubscribe: async () => {state.unsubscribed++; state.subscription = null; return true;},
    });
    if (subscribed) state.subscription = subscription(null);
    class FakeNotification {
      static get permission() {return state.permission;}
      static async requestPermission() {state.requested++; state.permission = answer; return answer;}
    }
    Object.defineProperty(window, 'Notification', {value: FakeNotification, configurable: true});
    Object.defineProperty(window, 'PushManager', {value: function PushManager() {}, configurable: true});
    const registration = {scope: '/', pushManager: {
      getSubscription: async () => state.subscription,
      subscribe: async (options: {applicationServerKey: Uint8Array}) => {state.subscribed++; state.subscription = subscription(options.applicationServerKey.buffer as ArrayBuffer); return state.subscription;},
    }};
    Object.defineProperty(navigator, 'serviceWorker', {configurable: true, value: {
      register: async () => {state.registered++; return registration;}, ready: Promise.resolve(registration),
      getRegistration: async () => state.registered || state.subscription ? registration : undefined,
      addEventListener() {}, removeEventListener() {},
    }});
  }, options);
}

export const pushState = (page: Page) => page.evaluate(() => {
  const {permission, requested, registered, subscribed, unsubscribed, subscription} = (window as unknown as {__push: {permission: string; requested: number; registered: number; subscribed: number; unsubscribed: number; subscription: unknown}}).__push;
  return {permission, requested, registered, subscribed, unsubscribed, active: !!subscription};
});
