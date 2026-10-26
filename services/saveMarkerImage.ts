import type { SQLiteDatabase } from 'expo-sqlite';
import { addImage } from '../database/operations';
import { copyImageToDocuments, removeImageCopy } from './imageFiles';

export async function saveMarkerImage(db: SQLiteDatabase, markerId: number, sourceUri: string) {
  const uri = await copyImageToDocuments(sourceUri);
  try {
    await addImage(db, markerId, uri);
  } catch (cause) {
    try {
      removeImageCopy(uri);
    } catch (cleanupError) {
      if (__DEV__) console.warn('[Files] Не удалось убрать копию после ошибки записи', cleanupError);
      throw new Error('Фото не записано в БД. Неиспользуемая копия будет очищена при следующем успешном обновлении.', { cause });
    }
    throw cause;
  }
}
