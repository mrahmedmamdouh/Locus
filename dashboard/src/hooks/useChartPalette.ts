import { useSyncExternalStore } from 'react';
import { DARK, LIGHT, type ChartPalette } from '../lib/palette';

const QUERY = '(prefers-color-scheme: dark)';

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

function isDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(QUERY).matches;
}

/** Chart palette that follows the OS light/dark setting live. */
export function useChartPalette(): ChartPalette {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  return dark ? DARK : LIGHT;
}
