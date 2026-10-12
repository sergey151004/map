import type { Marker } from '../types';
import { calculateDistance } from '../utils/calculateDistance';
import { removeNotification, showMarkerNotification } from './notifications';

// Выбранный радиус проекта: в задании конкретное число не задано.
export const PROXIMITY_THRESHOLD = 100;
export interface ActiveNotification {
  markerId: number;
  notificationId: string;
  timestamp: number;
}
type Position = { latitude: number; longitude: number };

export function createProximityManager(onError: (message: string | null) => void) {
  // Новый объект visit означает новый вход, даже если прежняя отправка ещё идёт.
  const visits = new Map<number, object>();
  const active = new Map<number, ActiveNotification>();
  const sending = new Set<number>();
  const removing = new Set<string>();
  const removalQueue = new Set<string>();
  let disposed = false;
  let hasPosition = false;

  function report(message: string) {
    if (!disposed) onError(message);
    if (__DEV__) console.warn('[Proximity]', message);
  }

  async function remove(id: string) {
    removalQueue.add(id);
    if (removing.has(id)) return;
    removing.add(id);
    try {
      const result = await removeNotification(id);
      if (result.ok) removalQueue.delete(id);
      else report(result.message);
    } catch {
      report('Не удалось убрать уведомление. Повторите попытку.');
    } finally {
      removing.delete(id);
    }
  }

  async function send(markerId: number) {
    const visit = visits.get(markerId);
    if (disposed || !hasPosition || !visit || active.has(markerId) || sending.has(markerId)) return;
    // Блокировка устанавливается до первого await, отдельно для каждой метки.
    sending.add(markerId);
    let succeeded = false;
    try {
      const result = await showMarkerNotification(markerId);
      succeeded = result.ok;
      if (result.ok) {
        if (!disposed && visits.get(markerId) === visit) {
          active.set(markerId, { markerId, notificationId: result.notificationId, timestamp: Date.now() });
        } else {
          // Пока шла отправка, пользователь вышел, метка удалена или провайдер закрыт.
          await remove(result.notificationId);
        }
      } else report(result.message);
    } catch {
      report('Не удалось отправить уведомление о метке. Повторите попытку.');
    } finally {
      sending.delete(markerId);
      // Быстрый выход и повторный вход: новую отправку начинаем после очистки старой.
      // При ошибке ждём следующего обновления GPS/меток или ручного повтора.
      if (succeeded && visits.get(markerId) !== visit) void send(markerId);
    }
  }

  function retry() {
    if (disposed) return;
    onError(null);
    for (const id of removalQueue) void remove(id);
    for (const id of visits.keys()) void send(id);
  }

  return {
    update(position: Position | null, markers: Marker[]) {
      if (disposed) return;
      hasPosition = position !== null;
      const existingIds = new Set(markers.map((marker) => marker.id));
      for (const id of visits.keys()) {
        if (!existingIds.has(id)) visits.delete(id);
      }
      if (position) {
        for (const marker of markers) {
          const distance = calculateDistance(position.latitude, position.longitude, marker.latitude, marker.longitude);
          if (distance <= PROXIMITY_THRESHOLD) {
            if (!visits.has(marker.id)) visits.set(marker.id, {});
          } else visits.delete(marker.id);
        }
      }
      // Отсутствие GPS (фон/ожидание/отказ) не считаем выходом из зоны.
      for (const [id, notification] of active) {
        if (!visits.has(id)) {
          active.delete(id);
          removalQueue.add(notification.notificationId);
        }
      }
      retry();
    },
    retry,
    dispose() {
      disposed = true;
      visits.clear();
      for (const notification of active.values()) removalQueue.add(notification.notificationId);
      active.clear();
      for (const id of removalQueue) void remove(id);
      // Завершающиеся позже отправки сами удалят свои уведомления.
    },
  };
}
