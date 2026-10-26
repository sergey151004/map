import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

const CHANNEL_ID = 'marker-alerts';
const NOTIFICATION_SCOPE = 'map-project/proximity-v1';
type Failure = { ok: false; reason: 'denied' | 'error'; message: string; notificationId?: string };
export type ShowNotificationResult = { ok: true; notificationId: string } | Failure;
export type RemoveNotificationResult = { ok: true } | Failure;
export interface ExistingMarkerNotification {
  markerId: number;
  notificationId: string;
  timestamp: number;
  presented: boolean;
}

const presentations = new Map<string, (success: boolean | null) => void>();
let sequence = 0;

// Загружается из корневого layout: один обработчик для всего приложения.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
  handleSuccess: (id) => presentations.get(id)?.(true),
  handleError: (id, error) => {
    presentations.get(id)?.(false);
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
  let notificationId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!Number.isSafeInteger(markerId) || markerId <= 0) throw new Error('Некорректный ID маркера');
    if (!(await ensurePermission())) {
      return { ok: false, reason: 'denied', message: 'Уведомления запрещены. Разрешите их в настройках приложения и канала «Уведомления о метках». Карта и фотографии остаются доступны.' };
    }
    notificationId = `map-marker-${markerId}-${Date.now()}-${++sequence}`;
    const id = notificationId;
    // Подписываемся до schedule: нативный callback может опередить его Promise.
    const presentation = new Promise<boolean | null>((resolve) => {
      presentations.set(id, resolve);
      timer = setTimeout(() => resolve(null), 5000);
    });
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: {
        title: 'Вы рядом с меткой!',
        body: `Рядом сохранённая метка №${markerId}.`,
        data: { markerId, scope: NOTIFICATION_SCOPE },
        sound: 'default',
      },
      // Только channelId на Android означает немедленный показ в данном канале.
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
    let presented = await presentation;
    if (presented === null) {
      // При уходе в фон обработчик JS может не вызываться: сверяем системный список.
      presented = (await Notifications.getPresentedNotificationsAsync())
        .some((notification) => notification.request.identifier === id);
    }
    if (!presented) {
      return { ok: false, notificationId: id, reason: 'error', message: 'Не удалось подтвердить показ уведомления. Повторите попытку.' };
    }
    return { ok: true, notificationId };
  } catch (error) {
    if (__DEV__) console.warn('[Notifications] Не удалось отправить', error);
    return { ok: false, notificationId, reason: 'error', message: 'Не удалось отправить уведомление. Попробуйте ещё раз.' };
  } finally {
    clearTimeout(timer);
    if (notificationId) presentations.delete(notificationId);
  }
}

export async function getMarkerNotifications(): Promise<ExistingMarkerNotification[]> {
  // Сначала очередь, затем показанные: уведомление, доставленное между чтениями,
  // попадёт хотя бы в один список. Одинаковые ID ниже объединяются.
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const presented = await Notifications.getPresentedNotificationsAsync();
  const found = new Map<string, ExistingMarkerNotification>();
  function remember(request: Notifications.NotificationRequest, timestamp: number, isPresented: boolean) {
    const { markerId, scope } = request.content.data ?? {};
    if (typeof markerId !== 'number' || !Number.isSafeInteger(markerId) || markerId <= 0) return;
    // Старые версии не записывали scope. Узнаём только их точный формат сообщения.
    const legacy = scope == null && request.content.title === 'Вы рядом с меткой!' &&
      request.content.body === `Рядом сохранённая метка №${markerId}.`;
    if (scope !== NOTIFICATION_SCOPE && !legacy) return;
    found.set(request.identifier, { markerId, notificationId: request.identifier, timestamp, presented: isPresented });
  }
  for (const request of scheduled) remember(request, 0, false);
  for (const notification of presented) remember(notification.request, notification.date, true);
  return [...found.values()];
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
