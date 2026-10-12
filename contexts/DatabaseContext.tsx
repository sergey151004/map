import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Button, StyleSheet, Text, View } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Marker, MarkerImage } from '../types';
import { createDatabaseConnection } from '../database/connection';
import * as operations from '../database/operations';
import { removeUnusedImageCopies } from '../services/imageFiles';
import { saveMarkerImage } from '../services/saveMarkerImage';
import { createDataTask } from '../services/createDataTask';

interface DatabaseContextValue {
  markers: Marker[];
  images: MarkerImage[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  retry: () => Promise<void>;
  dismissError: () => void;
  addMarker: (latitude: number, longitude: number) => Promise<number>;
  deleteMarker: (id: number) => Promise<void>;
  getMarkers: () => Promise<Marker[]>;
  addImage: (markerId: number, sourceUri: string) => Promise<void>;
  deleteImage: (id: number) => Promise<void>;
  getMarkerImages: (markerId: number) => Promise<MarkerImage[]>;
}

const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const [connection] = useState(createDatabaseConnection);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [images, setImages] = useState<MarkerImage[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(0);
  const retryAction = useRef<null | (() => Promise<unknown>)>(null);

  const execute = useCallback(<T,>(label: string, action: (db: SQLiteDatabase) => Promise<T>): Promise<T> => {
    const activeGeneration = generation.current;
    const isActive = () => mounted.current && generation.current === activeGeneration;
    const task = createDataTask(action, async (db) => {
      const nextMarkers = await operations.getMarkers(db);
      const nextImages = await operations.getAllImages(db);
      if (isActive()) {
        setMarkers(nextMarkers);
        setImages(nextImages);
        setIsReady(true);
      }
      try {
        removeUnusedImageCopies(nextImages.map((image) => image.uri));
      } catch (cause) {
        throw new Error('Данные сохранены, но не удалось удалить ненужные копии фото. Повторите очистку.', { cause });
      }
    });

    async function attempt(): Promise<T> {
      if (!isActive()) throw new Error('Соединение уже освобождается.');
      pending.current += 1;
      setIsLoading(true);
      setError(null);
      retryAction.current = null;
      try {
        return await connection.run(task);
      } catch (cause) {
        if (isActive()) {
          const detail = cause instanceof Error ? cause.message : 'Неизвестная ошибка.';
          setError(new Error(`${label}: ${detail}`, { cause }));
          retryAction.current = attempt;
        }
        if (__DEV__) console.warn(`[DatabaseProvider] ${label}`, cause);
        throw cause;
      } finally {
        pending.current -= 1;
        if (isActive()) setIsLoading(pending.current > 0);
      }
    }
    return attempt();
  }, [connection]);

  const refresh = useCallback(async () => {
    // Смена экрана не должна затирать возможность повторить неудачную запись.
    if (retryAction.current || pending.current > 0) return;
    await execute('Обновление данных', async () => undefined);
  }, [execute]);

  const retry = useCallback(async () => {
    if (pending.current > 0) return;
    await retryAction.current?.();
  }, []);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    void execute('Открытие базы', async () => undefined).catch(() => undefined);
    return () => {
      mounted.current = false;
      // close встаёт после всех принятых запросов; навигация провайдер не размонтирует.
      void connection.close().catch((cause) => {
        if (__DEV__) console.warn('[DatabaseProvider] Ошибка закрытия базы', cause);
      });
    };
  }, [connection, execute]);

  const value: DatabaseContextValue = {
    markers, images, isLoading, error, refresh, retry,
    dismissError: () => {
      if (pending.current > 0) return;
      retryAction.current = null;
      setError(null);
      void refresh().catch(() => undefined);
    },
    addMarker: (latitude, longitude) => execute('Добавление метки', (db) => operations.addMarker(db, latitude, longitude)),
    deleteMarker: (id) => execute('Удаление метки', (db) => operations.deleteMarker(db, id)),
    getMarkers: () => execute('Чтение меток', operations.getMarkers),
    addImage: (markerId, uri) => execute('Сохранение фото', (db) => saveMarkerImage(db, markerId, uri)),
    deleteImage: (id) => execute('Удаление фото', (db) => operations.deleteImage(db, id)),
    getMarkerImages: (id) => execute('Чтение фото', (db) => operations.getMarkerImages(db, id)),
  };

  return (
    <DatabaseContext.Provider value={value}>
      {isReady ? children : (
        <View style={styles.startup}>
          {isLoading && <ActivityIndicator size="large" />}
          <Text>{error?.message ?? 'Открытие базы данных…'}</Text>
          {error && <Button title="Повторить" disabled={isLoading} onPress={() => void retry().catch(() => undefined)} />}
        </View>
      )}
    </DatabaseContext.Provider>
  );
}

export function useDatabase() {
  const context = useContext(DatabaseContext);
  if (!context) throw new Error('useDatabase должен использоваться внутри DatabaseProvider');
  return context;
}

const styles = StyleSheet.create({
  startup: { flex: 1, justifyContent: 'center', padding: 24, gap: 16, backgroundColor: '#ffffff' },
});
