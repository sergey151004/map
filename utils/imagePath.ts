export function isPhotoFileName(name: string): boolean {
  return /^photo-\d+-[a-z0-9]+(?:\.[a-z0-9]{1,5})?$/.exec(name)?.[0] === name;
}

// Поддерживаем относительные пути и URI копий, созданных до версии БД 2.
// Старый корень контейнера не нужен; произвольные URI оставляем без изменений.
export function relativeImagePath(uri: string): string | null {
  const match = /^(?:file:\/\/\/[^?#]*\/)?marker-photos\/([^/]+)$/.exec(uri);
  if (!match || match[0] !== uri || !isPhotoFileName(match[1])) return null;
  return `marker-photos/${match[1]}`;
}
