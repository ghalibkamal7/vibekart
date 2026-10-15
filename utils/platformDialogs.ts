import { Alert, Platform } from 'react-native';

export function showPlatformAlert(title: string, message: string): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

export function confirmPlatformAction(
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void | Promise<void>,
  destructive = false,
): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}\n\nSelect OK to ${confirmLabel.toLowerCase()}.`)) {
      void onConfirm();
    }
    return;
  }

  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: confirmLabel,
      style: destructive ? 'destructive' : 'default',
      onPress: () => {
        void onConfirm();
      },
    },
  ]);
}
