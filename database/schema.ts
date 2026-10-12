import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { databaseOperation } from './errors';

export const DATABASE_NAME = 'markers.db';
export const DATABASE_VERSION = 1;

const INITIAL_SCHEMA = `
  CREATE TABLE markers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE marker_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marker_id INTEGER NOT NULL,
    uri TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (marker_id) REFERENCES markers (id) ON DELETE CASCADE
  );
`;

// Владелец соединения должен дождаться initDatabase и закрыть его через closeAsync,
// когда все запросы завершены. До возврата из функции соединение не используется UI.
export async function initDatabase(name = DATABASE_NAME): Promise<SQLiteDatabase> {
  return databaseOperation('инициализация базы', async () => {
    const db = await openDatabaseAsync(name, { useNewConnection: true });

    try {
      // PRAGMA действует на соединение и должна выполняться вне транзакции.
      await db.execAsync('PRAGMA foreign_keys = ON;');
      const foreignKeys = await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys;');
      if (foreignKeys?.foreign_keys !== 1) {
        throw new Error('Не удалось включить внешние ключи.');
      }

      await db.withTransactionAsync(async () => {
        const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
        if (!row) throw new Error('Не удалось прочитать версию схемы.');
        if (row.user_version > DATABASE_VERSION) {
          throw new Error(`Версия базы ${row.user_version} новее поддерживаемой ${DATABASE_VERSION}.`);
        }
        if (row.user_version < 0) throw new Error('Некорректная версия схемы.');

        if (row.user_version === 0) {
          await db.execAsync(INITIAL_SCHEMA);
          // PRAGMA не поддерживает bind-параметры. Здесь только постоянное число.
          await db.execAsync('PRAGMA user_version = 1;');
        }
      });

      return db;
    } catch (error) {
      // withTransactionAsync откатывает изменения при ошибке. Базу не удаляем.
      try {
        await db.closeAsync();
      } catch (closeError) {
        if (__DEV__) console.warn('[SQLite] Не удалось закрыть соединение после ошибки', closeError);
      }
      throw error;
    }
  });
}
