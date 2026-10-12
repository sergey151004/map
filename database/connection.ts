import type { SQLiteDatabase } from 'expo-sqlite';
import { initDatabase } from './schema';

// Очередь не даёт закрыть соединение посреди запроса или копирования фотографии.
// После close следующий запуск может открыть соединение заново (React Strict Mode).
export function createDatabaseConnection() {
  let db: SQLiteDatabase | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    run<T>(action: (database: SQLiteDatabase) => Promise<T>): Promise<T> {
      return enqueue(async () => {
        if (!db) db = await initDatabase();
        return action(db);
      });
    },
    close(): Promise<void> {
      return enqueue(async () => {
        if (db) {
          await db.closeAsync();
          db = null;
        }
      });
    },
  };
}
