import { Alert, Platform } from 'react-native';

/** Cross-platform confirm dialog (Alert buttons do not work on web). */
export function confirm(title: string, message: string, confirmLabel = 'OK', destructive = false): Promise<boolean> {
  if (Platform.OS === 'web') {
    const w = globalThis as { confirm?: (m: string) => boolean };
    return Promise.resolve(w.confirm ? w.confirm(`${title}\n\n${message}`) : true);
  }
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function notify(title: string, message: string): void {
  if (Platform.OS === 'web') {
    const w = globalThis as { alert?: (m: string) => void };
    w.alert?.(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}
