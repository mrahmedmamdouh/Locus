import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { deviceChecksToCsv, readingsToCsv, wifiScansToCsv, type DeviceCheck, type Reading, type WifiScan } from '@locus/altitude-core';
import { csvFileName, deviceChecksFileName, wifiScansFileName } from './exportName';

/**
 * Write readings to a CSV in the cache directory and open the share sheet.
 * Returns the file name. On web it triggers a browser download instead.
 */
export async function exportReadingsCsv(readings: Reading[], label: string): Promise<string> {
  return shareCsv(readingsToCsv(readings), csvFileName(label, new Date()), 'Export Locus readings');
}

/**
 * Device checks go in their own file (different header). expo-sharing shares one file per
 * call, so this is a separate export rather than part of "Export all".
 */
export async function exportDeviceChecksCsv(checks: DeviceCheck[]): Promise<string> {
  return shareCsv(deviceChecksToCsv(checks), deviceChecksFileName(new Date()), 'Export Locus device checks');
}

/** Wi-Fi scans: one row per access point, joined to readings by readingId. */
export async function exportWifiScansCsv(scans: WifiScan[]): Promise<string> {
  return shareCsv(wifiScansToCsv(scans), wifiScansFileName(new Date()), 'Export Locus Wi-Fi scans');
}

async function shareCsv(csv: string, name: string, dialogTitle: string): Promise<string> {
  if (Platform.OS === 'web') {
    downloadOnWeb(csv, name);
    return name;
  }
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  await file.write(csv);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error(`Sharing is not available on this device. The file was saved to ${file.uri}`);
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
    dialogTitle,
  });
  return name;
}

function downloadOnWeb(csv: string, name: string): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) throw new Error('Download is not supported here.');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
