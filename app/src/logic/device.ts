/** Device fields we may export. Deliberately excludes `deviceName`, which is user-chosen (often the owner's name). */
export interface DeviceInfo {
  modelName: string | null;
  brand: string | null;
  modelId: string | null;
}

/** Hardware model label for the CSV, e.g. "Pixel 8". Never contains the user-set device name. */
export function deviceModelLabel(d: DeviceInfo): string {
  const model = d.modelName?.trim();
  if (model) return model;
  return `${d.brand?.trim() ?? ''} ${d.modelId?.trim() ?? ''}`.trim() || 'unknown';
}
