// =====================================================================
// In the browser: the service worker, push on this device, and the
// browser's offer to install the app. Nothing here runs on the server.
// =====================================================================

import { pushConfig, subscribePush, unsubscribePush } from './push-fn';

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let installPrompt: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function isIos(): boolean {
  return typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
}

let registering: Promise<ServiceWorkerRegistration | null> | null = null;
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(null);
  if (!registering) {
    registering = navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.warn('[app] service worker not registered', err);
      return null;
    });
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e as InstallPrompt; notify(); });
    window.addEventListener('appinstalled', () => { installPrompt = null; notify(); });
  }
  return registering;
}

export function canInstall(): boolean { return !!installPrompt; }
export function onInstallChange(f: () => void): () => void { listeners.add(f); return () => listeners.delete(f); }
export async function install(): Promise<boolean> {
  if (!installPrompt) return false;
  await installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  notify();
  return outcome === 'accepted';
}

function keyBytes(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registerServiceWorker();
  return reg ? reg.pushManager.getSubscription() : null;
}

export type PushState = 'unsupported' | 'blocked' | 'off' | 'on';

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const sub = await currentSubscription();
  if (!sub) return 'off';
  const r = await pushConfig({ data: { endpoint: sub.endpoint } });
  return r.ok && r.subscribed ? 'on' : 'off';
}

/** Ask, subscribe, and tell the server whose notifications this device gets. */
export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  if (!pushSupported()) return { ok: false, error: isIos() && !isStandalone()
    ? 'On an iPhone, add the app to the home screen first, then turn notifications on from there.'
    : 'This browser cannot show notifications.' };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, error: 'Notifications were not allowed. Allow them in the browser settings to turn them on.' };
  const reg = await registerServiceWorker();
  if (!reg) return { ok: false, error: 'The app could not start its background worker.' };
  const cfg = await pushConfig({ data: {} });
  if (!cfg.ok) return { ok: false, error: cfg.error };
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.publicKey) as BufferSource });
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const r = await subscribePush({ data: { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, userAgent: navigator.userAgent } });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** Whoever is acting now gets this device's notifications, if it has them on. */
export async function rebindPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const sub = await currentSubscription();
  if (!sub) return;
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await subscribePush({ data: { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, userAgent: navigator.userAgent } }).catch(() => {});
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await unsubscribePush({ data: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
