import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

const CHANNEL_ID = 'marker-alerts';
type Failure = { ok: false; reason: 'denied' | 'error'; message: string };
export type ShowNotificationResult = { ok: true; notificationId: string } | Failure;
export type RemoveNotificationResult = { ok: true } | Failure;

// Загружается из корневого layout: один обработчик для всего приложения.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
  handleError: (_id, error) => {
    if (__DEV__) console.warn('[Notifications] Ошибка показа', error);
  },
});

let permissionRequest: Promise<boolean> | null = null;
let askedThisSession = false;

function ensurePermission(): Promise<boolean> {
  if (permissionRequest) return permissionRequest;
  permissionRequest = (async () => {
    // На Android канал создаётся до запроса разрешения (в том числе Android 13+).
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Уведомления о метках',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
      });
    }
    let permission = await Notifications.getPermissionsAsync();
    if (permission.status === 'undetermined' && permission.canAskAgain && !askedThisSession) {
      askedThisSession = true;
      permission = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false },
      });
    }
    const allowed = permission.granted ||
      permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
      permission.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL;
    if (!allowed) return false;
    if (Platform.OS === 'android') {
      const channel = await Notifications.getNotificationChannelAsync(CHANNEL_ID);
      if (channel?.importance === Notifications.AndroidImportance.NONE) return false;
    }
    return true;
  })().finally(() => { permissionRequest = null; });
  return permissionRequest;
}

export async function showMarkerNotification(markerId: number): Promise<ShowNotificationResult> {
  try {
    if (!Number.isSafeInteger(markerId) || markerId <= 0) throw new Error('Некорректный ID маркера');
    if (!(await ensurePermission())) {
      return { ok: false, reason: 'denied', message: 'Уведомления запрещены. Разрешите их в настройках приложения и канала «Уведомления о метках». Карта и фотографии остаются доступны.' };
    }
    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Вы рядом с меткой!',
        body: `Рядом сохранённая метка №${markerId}.`,
        data: { markerId },
        sound: 'default',
      },
      // Только channelId на Android означает немедленный показ в данном канале.
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
    return { ok: true, notificationId };
  } catch (error) {
    if (__DEV__) console.warn('[Notifications] Не удалось отправить', error);
    return { ok: false, reason: 'error', message: 'Не удалось отправить уведомление. Попробуйте ещё раз.' };
  }
}

export async function removeNotification(notificationId: string): Promise<RemoveNotificationResult> {
  // Пытаемся выполнить обе операции даже при ошибке одной из них.
  const results = await Promise.allSettled([
    Notifications.cancelScheduledNotificationAsync(notificationId),
    Notifications.dismissNotificationAsync(notificationId),
  ]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) {
    if (__DEV__) console.warn('[Notifications] Не удалось удалить', failure.reason);
    return { ok: false, reason: 'error', message: 'Не удалось удалить уведомление. Попробуйте ещё раз.' };
  }
  return { ok: true };
}
