import type { Marker } from '../types';
import { calculateDistance } from '../utils/calculateDistance';
import { getMarkerNotifications, removeNotification, showMarkerNotification } from './notifications';

// Выбранный радиус проекта: в задании конкретное число не задано.
export const PROXIMITY_THRESHOLD = 100;
export const PROXIMITY_EXIT_THRESHOLD = 150;
export const MAX_POSITION_AGE_MS = 30_000;
export const MAX_POSITION_ACCURACY = 50;
export interface ActiveNotification {
  markerId: number;
  notificationId: string;
  timestamp: number;
}
type Position = { latitude: number; longitude: number; accuracy: number | null; timestamp: number };

function usablePosition(position: Position | null): position is Position {
  if (!position) return false;
  const age = Date.now() - position.timestamp;
  return Number.isFinite(position.latitude) && Math.abs(position.latitude) <= 90 &&
    Number.isFinite(position.longitude) && Math.abs(position.longitude) <= 180 &&
    position.accuracy !== null && Number.isFinite(position.accuracy) &&
    position.accuracy >= 0 && position.accuracy <= MAX_POSITION_ACCURACY &&
    Number.isFinite(age) && age >= -5000 && age <= MAX_POSITION_AGE_MS;
}

export function createProximityManager(onError: (message: string | null) => void) {
  // Новый объект visit означает новый вход, даже если прежняя отправка ещё идёт.
  const visits = new Map<number, object>();
  const active = new Map<number, ActiveNotification>();
  const sending = new Set<number>();
  const removing = new Set<string>();
  // До успешного удаления старого уведомления новое для этой метки не отправляем.
  const removalQueue = new Map<string, number>();
  let disposed = false;
  let position: Position | null = null;
  let markers: Marker[] = [];
  let restored = false;
  let restoring = false;

  function report(message: string) {
    if (!disposed) onError(message);
    if (__DEV__) console.warn('[Proximity]', message);
  }

  async function remove(id: string, markerId: number, resume = true) {
    removalQueue.set(id, markerId);
    if (removing.has(id)) return;
    removing.add(id);
    try {
      const result = await removeNotification(id);
      if (result.ok) {
        removalQueue.delete(id);
        if (resume) void send(markerId);
      }
      else report(result.message);
    } catch {
      report('Не удалось убрать уведомление. Повторите попытку.');
    } finally {
      removing.delete(id);
    }
  }

  async function send(markerId: number) {
    const visit = visits.get(markerId);
    if (disposed || !restored || !usablePosition(position) || !visit || active.has(markerId) || sending.has(markerId)) return;
    if ([...removalQueue.values()].includes(markerId)) return;
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
          await remove(result.notificationId, markerId);
        }
      } else {
        report(result.message);
        // Не считаем неудачный показ активным. Удаляем его перед будущим повтором.
        if (result.notificationId) await remove(result.notificationId, markerId, false);
      }
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
    if (!restored) { void restore(); return; }
    onError(null);
    for (const [id, markerId] of removalQueue) void remove(id, markerId);
    for (const id of visits.keys()) void send(id);
  }

  async function restore() {
    if (disposed || restoring || restored) return;
    restoring = true;
    try {
      const notifications = await getMarkerNotifications();
      if (disposed) return;
      for (const notification of notifications) {
        if (notification.presented && !active.has(notification.markerId)) {
          active.set(notification.markerId, notification);
          visits.set(notification.markerId, {});
        } else removalQueue.set(notification.notificationId, notification.markerId);
      }
      restored = true;
      updateVisits();
      retry();
    } catch {
      report('Не удалось восстановить системные уведомления. Нажмите «Повторить уведомления».');
    } finally { restoring = false; }
  }

  function updateVisits() {
    const existingIds = new Set(markers.map((marker) => marker.id));
    for (const id of visits.keys()) {
      if (!existingIds.has(id)) visits.delete(id);
    }
    if (usablePosition(position)) {
      for (const marker of markers) {
        const distance = calculateDistance(position.latitude, position.longitude, marker.latitude, marker.longitude);
        if (distance <= PROXIMITY_THRESHOLD) {
          if (!visits.has(marker.id)) visits.set(marker.id, {});
        } else if (distance > PROXIMITY_EXIT_THRESHOLD) visits.delete(marker.id);
      }
    }
    // Неточный, старый или отсутствующий GPS не означает выход из зоны.
    for (const [id, notification] of active) {
      if (!visits.has(id)) {
        active.delete(id);
        removalQueue.set(notification.notificationId, id);
      }
    }
  }

  return {
    update(nextPosition: Position | null, nextMarkers: Marker[]) {
      if (disposed) return;
      position = nextPosition;
      markers = nextMarkers;
      updateVisits();
      retry();
    },
    retry,
    dispose() {
      disposed = true;
      visits.clear();
      for (const notification of active.values()) removalQueue.set(notification.notificationId, notification.markerId);
      active.clear();
      for (const [id, markerId] of removalQueue) void remove(id, markerId);
      // Завершающиеся позже отправки сами удалят свои уведомления.
    },
  };
}
