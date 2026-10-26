import { localDateStamp } from './time';

/** Filesystem-safe slug: lowercase ASCII letters, digits and dashes. */
export function slugify(text: string): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'venue';
}

/** locus-readings-<venue>-<YYYY-MM-DD>.csv */
export function csvFileName(venueOrAll: string, date: Date): string {
  return `locus-readings-${slugify(venueOrAll)}-${localDateStamp(date)}.csv`;
}
