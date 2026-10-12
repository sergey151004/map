import type { SQLiteDatabase } from 'expo-sqlite';

// Повтор после сбоя обновления/очистки не должен повторять успешный INSERT.
export function createDataTask<T>(
  action: (db: SQLiteDatabase) => Promise<T>,
  synchronize: (db: SQLiteDatabase) => Promise<void>,
) {
  let completed = false;
  let result: T;
  return async (db: SQLiteDatabase): Promise<T> => {
    if (!completed) {
      result = await action(db);
      completed = true;
    }
    await synchronize(db);
    return result;
  };
}
