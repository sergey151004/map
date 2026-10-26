import type { SQLiteDatabase } from 'expo-sqlite';

type PendingPick = { token: string; markerId: number; sourceUri: string | null };

export function getPendingImagePick(db: SQLiteDatabase) {
  return db.getFirstAsync<PendingPick>(
    'SELECT token, marker_id AS markerId, source_uri AS sourceUri FROM pending_image_pick WHERE id = 1',
  );
}

export async function beginImagePick(db: SQLiteDatabase, token: string, markerId: number) {
  await db.runAsync('INSERT INTO pending_image_pick (id, token, marker_id) VALUES (1, ?, ?)', token, markerId);
}

export async function setPickedImageSource(db: SQLiteDatabase, token: string, sourceUri: string) {
  await db.runAsync('UPDATE pending_image_pick SET source_uri = ? WHERE token = ?', sourceUri, token);
}

export async function clearImagePick(db: SQLiteDatabase, token: string) {
  await db.runAsync('DELETE FROM pending_image_pick WHERE token = ?', token);
}
