import { useRef, useState } from 'react';
import { Alert, Button, Linking, Text, View } from 'react-native';
import { removeNotification, showMarkerNotification } from '../services/notifications';

export function TestNotification({ markerId }: { markerId: number }) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notificationId, setNotificationId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  async function run(remove: boolean) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    setDenied(false);
    try {
      if (remove && notificationId) {
        const result = await removeNotification(notificationId);
        if (result.ok) {
          setNotificationId(null);
          setMessage('Уведомление удалено.');
        } else setMessage(result.message);
      } else {
        const result = await showMarkerNotification(markerId);
        if (result.ok) {
          setNotificationId(result.notificationId);
          setMessage('Уведомление отправлено. Проверьте баннер и центр уведомлений.');
        } else {
          setMessage(result.message);
          setDenied(result.reason === 'denied');
        }
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Button title="Тестовое уведомление" disabled={busy || notificationId !== null} onPress={() => void run(false)} />
      {notificationId && <Button title="Удалить тестовое уведомление" disabled={busy} onPress={() => void run(true)} />}
      {message && <Text accessibilityRole="alert">{message}</Text>}
      {denied && <Button title="Настройки уведомлений" onPress={() => {
        void Linking.openSettings().catch(() => Alert.alert('Откройте настройки вручную', 'Проверьте разрешения уведомлений для Expo Go.'));
      }} />}
    </View>
  );
}
