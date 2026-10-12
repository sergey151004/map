import { Directory, File, Paths } from 'expo-file-system';

const photoName = /^photo-\d+-[a-z0-9]+(?:\.[a-z0-9]{1,5})?$/;

function photoDirectory() {
  return new Directory(Paths.document, 'marker-photos');
}

function isOwnedPhoto(file: File, directory: Directory) {
  return file.parentDirectory.uri === directory.uri && photoName.test(file.name);
}

export function removeImageCopy(uri: string) {
  const file = new File(uri);
  // Никогда не удаляем оригиналы из галереи, чужие файлы или каталоги.
  if (isOwnedPhoto(file, photoDirectory()) && file.exists) file.delete();
}

export function copyImageToDocuments(sourceUri: string): string {
  const directory = photoDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const source = new File(sourceUri);
  const extension = source.extension.toLowerCase();
  const suffix = /^\.[a-z0-9]{1,5}$/.test(extension) ? extension : '';
  let destination: File;
  do {
    const randomPart = Math.random().toString(36).slice(2) || '0';
    destination = new File(directory, `photo-${Date.now()}-${randomPart}${suffix}`);
  } while (destination.exists);

  try {
    source.copy(destination);
    if (!destination.exists || destination.size === 0) {
      throw new Error('Копия фотографии не создана или пуста.');
    }
    return destination.uri;
  } catch (cause) {
    try {
      removeImageCopy(destination.uri);
    } catch (cleanupError) {
      if (__DEV__) console.warn('[Files] Осталась незавершённая копия; очистка будет повторена', cleanupError);
    }
    throw new Error('Не удалось сохранить фотографию в документах приложения.', { cause });
  }
}

// Вызывается только после успешного чтения всех URI из БД, внутри общей очереди.
// Помогает и после остановки приложения между копированием/записью или удалением.
export function removeUnusedImageCopies(usedUris: string[]) {
  const directory = photoDirectory();
  if (!directory.exists) return;
  const used = new Set(usedUris);
  for (const entry of directory.list()) {
    if (entry instanceof File && isOwnedPhoto(entry, directory) && !used.has(entry.uri)) {
      entry.delete();
    }
  }
}
