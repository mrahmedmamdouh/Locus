/** Short unique id; good enough for on-device records (no server, no collisions across testers needed). */
export function makeId(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}
