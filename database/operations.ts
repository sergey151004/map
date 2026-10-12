import type { SQLiteDatabase } from 'expo-sqlite';
import type { Marker, MarkerImage } from '../types';
import { databaseOperation } from './errors';

// created_at по схеме допускает NULL. В приложении используем camelCase,
// имена столбцов в самой базе остаются точно такими, как в задании.
export interface StoredMarker extends Marker {
  createdAt: string | null;
}

export interface StoredMarkerImage extends MarkerImage {
  createdAt: string | null;
}

// Во все операции передаётся соединение, полученное через initDatabase.
export async function addMarker(db: SQLiteDatabase, latitude: number, longitude: number): Promise<number> {
  return databaseOperation('добавление маркера', async () => {
    const result = await db.runAsync(
      'INSERT INTO markers (latitude, longitude) VALUES (?, ?)',
      latitude, longitude,
    );
    return result.lastInsertRowId;
  });
}

export async function deleteMarker(db: SQLiteDatabase, id: number): Promise<void> {
  return databaseOperation('удаление маркера', async () => {
    // DELETE и каскад выполняются атомарно в неявной транзакции SQLite.
    // Ручное удаление изображений отдельным запросом не требуется.
    await db.runAsync('DELETE FROM markers WHERE id = ?', id);
  });
}

export async function getMarkers(db: SQLiteDatabase): Promise<StoredMarker[]> {
  return databaseOperation('чтение маркеров', () => db.getAllAsync<StoredMarker>(
    'SELECT id, latitude, longitude, created_at AS createdAt FROM markers ORDER BY id',
  ));
}

export async function addImage(db: SQLiteDatabase, markerId: number, uri: string): Promise<void> {
  return databaseOperation('добавление изображения', async () => {
    await db.runAsync('INSERT INTO marker_images (marker_id, uri) VALUES (?, ?)', markerId, uri);
  });
}

export async function deleteImage(db: SQLiteDatabase, id: number): Promise<void> {
  return databaseOperation('удаление изображения', async () => {
    await db.runAsync('DELETE FROM marker_images WHERE id = ?', id);
  });
}

export async function getMarkerImages(db: SQLiteDatabase, markerId: number): Promise<StoredMarkerImage[]> {
  return databaseOperation('чтение изображений', () => db.getAllAsync<StoredMarkerImage>(
    'SELECT id, marker_id AS markerId, uri, created_at AS createdAt FROM marker_images WHERE marker_id = ? ORDER BY id',
    markerId,
  ));
}

// Нужны провайдеру для обновления кэша и безопасной очистки файлов без записей в БД.
export async function getAllImages(db: SQLiteDatabase): Promise<StoredMarkerImage[]> {
  return databaseOperation('чтение всех изображений', () => db.getAllAsync<StoredMarkerImage>(
    'SELECT id, marker_id AS markerId, uri, created_at AS createdAt FROM marker_images ORDER BY id',
  ));
}
