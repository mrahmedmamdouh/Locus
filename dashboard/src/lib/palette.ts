import type { AltitudeSource } from '@locus/altitude-core';

/**
 * Chart colours. Mirrors the CSS tokens in styles.css; kept in JS because
 * Recharts writes SVG presentation attributes, which cannot read CSS variables.
 * Categorical order (blue, orange, aqua) validated for CVD separation in both modes.
 */
export interface ChartPalette {
  series: Record<AltitudeSource, string>;
  grid: string;
  axis: string;
  tick: string;
  reference: string;
  threshold: string;
  surface: string;
}

export const LIGHT: ChartPalette = {
  series: { baro: '#2a78d6', gps: '#eb6834', os: '#1baf7a' },
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  tick: '#6c6a64',
  reference: '#52514e',
  threshold: '#d03b3b',
  surface: '#fcfcfb',
};

export const DARK: ChartPalette = {
  series: { baro: '#3987e5', gps: '#d95926', os: '#199e70' },
  grid: '#2c2c2a',
  axis: '#383835',
  tick: '#9a988f',
  reference: '#c3c2b7',
  threshold: '#e66767',
  surface: '#1a1a19',
};
