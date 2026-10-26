import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { SQLiteDatabase } from 'expo-sqlite';
import { saveMarkerImage } from './saveMarkerImage';
import { beginImagePick, clearImagePick as clearPick, getPendingImagePick as pendingPick, setPickedImageSource } from '../database/imagePicker';

type PickResult = ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult;
let picking = false;
let recoveryResult: Promise<PickResult | null> | null = null;

export class ImagePickRecoveryError extends Error {}

async function finishPick(db: SQLiteDatabase, token: string, sourceUri: string) {
  // INSERT фото и потребление запроса атомарны: повтор не добавит вторую копию.
  await db.withTransactionAsync(async () => {
    const pending = await pendingPick(db);
    if (!pending || pending.token !== token) return;
    await saveMarkerImage(db, pending.markerId, sourceUri);
    await clearPick(db, token);
  });
}

async function acceptResult(db: SQLiteDatabase, token: string, result: PickResult) {
  const pending = await pendingPick(db);
  if (!pending || pending.token !== token) return;
  if ('code' in result) {
    await clearPick(db, token);
    throw new Error('Не удалось восстановить выбранную фотографию. Откройте галерею ещё раз.');
  }
  if (result.canceled) { await clearPick(db, token); return; }
  const sourceUri = result.assets[0]?.uri;
  if (!sourceUri) {
    await clearPick(db, token);
    throw new Error('В результате выбора нет фотографии. Выберите изображение ещё раз.');
  }
  // Сохраняем результат до копирования: getPendingResultAsync потребляет нативный результат.
  await setPickedImageSource(db, token, sourceUri);
  await finishPick(db, token, sourceUri);
}

async function recover(db: SQLiteDatabase) {
  const pending = await pendingPick(db);
  if (pending?.sourceUri) {
    await finishPick(db, pending.token, pending.sourceUri);
    recoveryResult = null;
    return;
  }
  if (!recoveryResult) {
    recoveryResult = Platform.OS === 'android' ? ImagePicker.getPendingResultAsync() : Promise.resolve(null);
    recoveryResult = recoveryResult.catch((error) => { recoveryResult = null; throw error; });
  }
  const result = await recoveryResult;
  // Без сохранённого ID не угадываем метку по открытому экрану.
  if (pending) {
    if (result) await acceptResult(db, pending.token, result);
    else await clearPick(db, pending.token);
  }
  recoveryResult = null;
}

export async function recoverPendingImagePick(db: SQLiteDatabase) {
  try {
    if (!picking) await recover(db);
  } catch (cause) {
    throw new ImagePickRecoveryError('Не удалось восстановить фото. Повторите попытку или пропустите восстановление и выберите фото заново.', { cause });
  }
}

export async function discardPendingImagePick(db: SQLiteDatabase) {
  const pending = await pendingPick(db);
  if (pending) await clearPick(db, pending.token);
  recoveryResult = null;
}

export function createImagePickTask(markerId: number) {
  let token: string | null = null;
  let result: ImagePicker.ImagePickerResult | undefined;
  return async (db: SQLiteDatabase) => {
    if (picking) throw new Error('Выбор фотографии уже открыт.');
    picking = true;
    try {
      if (token) {
        const pending = await pendingPick(db);
        if (!pending || pending.token !== token) return;
        if (pending.sourceUri) await finishPick(db, token, pending.sourceUri);
        else if (result) await acceptResult(db, token, result);
        return;
      }
      await recover(db);
      const nextToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await beginImagePick(db, nextToken, markerId);
      token = nextToken;
      try {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'], allowsEditing: false, allowsMultipleSelection: false, quality: 1,
        });
      } catch (cause) {
        await clearPick(db, token);
        throw new Error('Не удалось открыть галерею. Проверьте доступ к фотографиям и повторите выбор.', { cause });
      }
      await acceptResult(db, token, result);
    } finally { picking = false; }
  };
}
