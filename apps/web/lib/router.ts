import { useMemo, useSyncExternalStore } from 'react';

const NAVIGATION_EVENT = 'omnistudio:navigate';

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAVIGATION_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAVIGATION_EVENT, listener);
  };
}

function snapshot() {
  const path = window.location.pathname;
  return path.length > 1 ? path.replace(/\/$/, '') : path;
}

function navigate(path: string, replace: boolean) {
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function usePathname() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useRouter() {
  return useMemo(() => ({
    push: (path: string) => navigate(path, false),
    replace: (path: string) => navigate(path, true),
  }), []);
}
