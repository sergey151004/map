# Карта и метки

Одно учебное приложение для трёх последовательных заданий из `tasks/`.
Выполнен только подготовительный этап: Expo, React Native, TypeScript и Expo Router.
Главный экран и экран метки — заглушки с переходом туда и обратно.
Карта, изображения, SQLite, React Context, геолокация и уведомления будут добавляться на следующих этапах.

## Установка и запуск

Требуются Node.js LTS, npm и Expo Go с поддержкой SDK 57.
Версию Expo Go можно проверить на https://expo.dev/go.

```powershell
cd D:\coding\map_project
npm ci
npm start
```

Зависимости уже установлены при подготовке. `npm ci` нужен после скачивания проекта
или для повторной установки точных версий из `package-lock.json`.
Команда `npm start` выполняет `expo start --go`.
В `.npmrc` кеш npm направлен в `.npm-cache/` внутри проекта, поскольку при подготовке
на системном диске C: не хватило места. Эта папка исключена из Git и проверки TypeScript.

1. Установите Expo Go на телефон и подключите телефон и компьютер к одной сети Wi-Fi.
2. Отсканируйте QR-код из терминала: на Android — сканером в Expo Go, на iPhone — камерой.
3. На экране «Карта» нажмите «Открыть тестовую метку».
4. Убедитесь, что показано «Метка №1», затем нажмите «Вернуться к карте».
5. Повторите переход и проверьте кнопку назад в заголовке экрана.

Если локальная сеть блокирует соединение, разрешите Node.js доступ к частной сети
в брандмауэре Windows или запустите туннель:

```powershell
npx expo start --go --tunnel
```

При первом запуске туннеля Expo может предложить установить `@expo/ngrok`.
Для уже настроенного Android-эмулятора можно использовать `npm run android`.
iOS-симулятор требует macOS; на Windows используйте физический iPhone с Expo Go.

## Проверки

```powershell
npm run typecheck
npx expo install --check
npx expo config --type public
npx expo-doctor
npx expo export --platform all
```

Экспорт проверяет сборку JavaScript для Android и iOS, но не заменяет проверку на устройстве.
Результат экспорта находится в игнорируемой папке `dist/`.

При подготовке успешно выполнены проверка TypeScript, `expo install --check`,
чтение конфигурации, все 21 проверки Expo Doctor и экспорт Hermes для Android и iOS.
Команда `npm start` проверена: Metro запустился в режиме Expo Go; пробный сервер остановлен.
Проверка на физическом телефоне или эмуляторе в этой среде недоступна.

## Структура

- `app/_layout.tsx` — стек навигации и заголовки.
- `app/index.tsx` — заглушка карты и ссылка на тестовую метку.
- `app/marker/[id].tsx` — параметр `id` из маршрута и возврат к карте.
- `app.json` — конфигурация Expo и плагина Router.
- `tsconfig.json` — строгая проверка TypeScript на основе конфигурации Expo.
- `tasks/` — исходные задания, сохранены без изменений.

Используются функциональные компоненты и хук `useLocalSearchParams`.
Общее состояние пока отсутствует, поэтому пустой Context не создаётся.
Проект настроен для Android и iOS; демонстрационных вкладок и экранов шаблона нет.

Зависимости Expo подбираются через `npx expo install`, а не через установку
произвольных `latest` из примеров заданий. При добавлении следующих возможностей
нужно сверяться с документацией установленного SDK: пример SQLite с
`openDatabase` / `transaction` в задании 2 устарел.

Основа проекта: Expo SDK 57, React 19.2.3, React Native 0.86.3 и Expo Router 57.
Версии React DOM, Gesture Handler, Reanimated и Worklets также закреплены по
списку совместимости Expo: они требуются дереву зависимостей Router.
Повторно подбирать их при обычной установке не нужно — используйте `npm ci`.

Команды подбора зависимостей при подготовке:

```powershell
npx expo install expo react react-native expo-router react-native-safe-area-context react-native-screens expo-linking expo-constants expo-status-bar
npx expo install react-dom react-native-reanimated react-native-worklets react-native-gesture-handler
npx expo install typescript @types/react --dev
```

Документация: [установка Expo Router](https://docs.expo.dev/router/installation/),
[Expo Router для SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/router/).
