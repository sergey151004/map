import { AppState } from 'react-native';
import * as Location from 'expo-location';

export type LocationStatus = 'checking' | 'waiting' | 'tracking' | 'denied' | 'disabled' | 'error' | 'paused';

export interface ForegroundLocationState {
  status: LocationStatus;
  position: Location.LocationObject | null;
  message: string;
  canAskAgain: boolean;
}

export const INITIAL_LOCATION_STATE: ForegroundLocationState = {
  status: 'checking', position: null, message: 'Проверяем доступ к местоположению…', canAskAgain: true,
};

// Общая очередь запуска нужна и для размонтирования/повторного монтажа в Strict Mode:
// новый watch не создаётся, пока предыдущий асинхронный запуск не завершён и не очищен.
let startupQueue: Promise<void> = Promise.resolve();

export function trackForegroundLocation(onChange: (state: ForegroundLocationState) => void) {
  let disposed = false;
  let active = AppState.currentState === 'active';
  let generation = 0;
  let subscription: Location.LocationSubscription | null = null;
  let firstFixTimer: ReturnType<typeof setTimeout> | undefined;
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  let state = INITIAL_LOCATION_STATE;

  const valid = (token: number) => !disposed && active && token === generation;
  function update(changes: Partial<ForegroundLocationState>) {
    if (disposed) return;
    state = { ...state, ...changes };
    onChange(state);
  }

  function stop() {
    generation += 1;
    clearTimeout(firstFixTimer);
    clearTimeout(healthTimer);
    firstFixTimer = undefined;
    healthTimer = undefined;
    subscription?.remove();
    subscription = null;
  }

  function deny(canAskAgain: boolean) {
    stop();
    update({ status: 'denied', position: null, canAskAgain,
      message: 'Доступ к местоположению не разрешён. Карта, метки и фотографии доступны.' });
  }

  function disable() {
    stop();
    update({ status: 'disabled', position: null,
      message: 'Геолокация телефона выключена. Включите её и нажмите «Повторить».' });
  }

  async function fail(token: number, cause: unknown) {
    if (!valid(token)) return;
    stop();
    const errorToken = generation;
    update({ status: 'error', position: null, message: 'Не удалось получить местоположение. Попробуйте ещё раз.' });
    if (__DEV__) console.warn('[Location] Ошибка получения координат', cause);
    // Ошибка подписки может означать отзыв разрешения или отключение GPS.
    try {
      const permission = await Location.getForegroundPermissionsAsync();
      if (!valid(errorToken)) return;
      if (!permission.granted) { deny(permission.canAskAgain); return; }
      const enabled = await Location.hasServicesEnabledAsync();
      if (valid(errorToken) && !enabled) disable();
    } catch {
      // Уже показали ошибку. Проверка причины не должна скрывать её.
    }
  }

  function scheduleHealthCheck(token: number) {
    healthTimer = setTimeout(async () => {
      try {
        const enabled = await Location.hasServicesEnabledAsync();
        if (!valid(token)) return;
        if (!enabled) { disable(); return; }
        const permission = await Location.getForegroundPermissionsAsync();
        if (!valid(token)) return;
        if (!permission.granted) { deny(permission.canAskAgain); return; }
        scheduleHealthCheck(token);
      } catch (cause) {
        void fail(token, cause);
      }
    }, 5000);
  }

  function start(askAgain = false) {
    stop();
    if (!active || disposed) return;
    const token = generation;
    update({ ...INITIAL_LOCATION_STATE });

    startupQueue = startupQueue.then(async () => {
      if (!valid(token)) return;
      try {
        let permission = await Location.getForegroundPermissionsAsync();
        if (!valid(token)) return;
        // После отказа не показываем запрос при каждом возврате на экран/из фона.
        if (!permission.granted && permission.canAskAgain && (permission.status === 'undetermined' || askAgain)) {
          permission = await Location.requestForegroundPermissionsAsync();
        }
        if (!valid(token)) return;
        if (!permission.granted) { deny(permission.canAskAgain); return; }
        const enabled = await Location.hasServicesEnabledAsync();
        if (!valid(token)) return;
        if (!enabled) { disable(); return; }

        update({ status: 'waiting', message: 'Ожидаем первую позицию…', canAskAgain: permission.canAskAgain });
        firstFixTimer = setTimeout(() => {
          if (valid(token)) update({ message: 'Позиция пока не получена. Попробуйте выйти на открытое место или повторить.' });
        }, 20000);

        const started = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 5 },
          (position) => {
            if (!valid(token)) return;
            clearTimeout(firstFixTimer);
            firstFixTimer = undefined;
            update({ status: 'tracking', position, message: 'Ваше местоположение' });
          },
          (reason) => { void fail(token, reason); },
        );
        if (!valid(token)) {
          // Запуск завершился уже после ухода в фон, повтора или размонтирования.
          started.remove();
          return;
        }
        subscription = started;
        scheduleHealthCheck(token);
      } catch (cause) {
        await fail(token, cause);
      }
    });
  }

  const appStateListener = AppState.addEventListener('change', (nextState) => {
    const nextActive = nextState === 'active';
    if (active === nextActive) return;
    active = nextActive;
    if (active) start();
    else {
      stop();
      update({ status: 'paused', position: null, message: 'Отслеживание приостановлено.' });
    }
  });

  if (active) start();
  else update({ status: 'paused', position: null, message: 'Отслеживание приостановлено.' });

  return {
    retry() { if (!disposed) start(true); },
    dispose() {
      disposed = true;
      stop();
      appStateListener.remove();
    },
  };
}
