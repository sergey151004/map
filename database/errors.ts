// Исходная ошибка сохраняется в cause, в том числе ошибки ограничений SQLite.
export async function databaseOperation<T>(name: string, action: () => Promise<T>): Promise<T> {
  try {
    const result = await action();
    if (__DEV__) console.info(`[SQLite] ${name}: OK`);
    return result;
  } catch (cause) {
    if (__DEV__) console.warn(`[SQLite] ${name}: ошибка`, cause);
    throw new Error(`Ошибка SQLite: ${name}.`, { cause });
  }
}
