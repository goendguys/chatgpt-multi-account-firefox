# ChatGPT Multi-Account for Firefox

[![Check and build](https://github.com/goendguys/chatgpt-multi-account-firefox/actions/workflows/check.yml/badge.svg)](https://github.com/goendguys/chatgpt-multi-account-firefox/actions/workflows/check.yml)
[![Release](https://img.shields.io/github/v/release/goendguys/chatgpt-multi-account-firefox)](https://github.com/goendguys/chatgpt-multi-account-firefox/releases/latest)

[Русский](#русский) · [English](#english)

## Русский

Неофициальное локальное расширение Firefox для удобного переключения между своими аккаунтами ChatGPT и фоновой проверки доступного лимита каждого аккаунта.

### Возможности

- Кнопка аккаунтов под кнопкой **«Временный чат»** на `chatgpt.com`.
- Сохранение текущего аккаунта как локального снимка cookie и переключение одним нажатием.
- Точный буквенный аватар из `cdn.auth0.com`, адрес которого ChatGPT хранит в cookie профиля; цветовой анализ и резервные цвета используются только при отсутствии картинки.
- Остаток показывается первым: **«Доступно 83%»**, затем **«Использовано 17%»**.
- Фоновая проверка всех сохранённых аккаунтов без видимого переключения вкладки.
- Поиск, переименование, удаление, импорт и экспорт JSON, автообновление и Firefox Containers.
- Русский и английский интерфейс через штатную локализацию Firefox.
- Нет телеметрии, аналитики, удалённого кода и сторонних серверов.

### Установка и использование

Требуется Firefox 142 или новее.

1. Скачайте ZIP со страницы [последнего релиза](https://github.com/goendguys/chatgpt-multi-account-firefox/releases/latest) или клонируйте репозиторий.
2. Откройте `about:debugging#/runtime/this-firefox`.
3. Нажмите **«Загрузить временное дополнение»** и выберите `manifest.json`.
4. Один раз обновите уже открытую вкладку ChatGPT.
5. В меню расширения нажмите **«Добавить этот аккаунт»**, затем войдите в остальные аккаунты и сохраните их таким же способом.

Временное дополнение отключается после перезапуска Firefox. Для постоянной публикации архив должен быть подписан через Mozilla Add-ons. Если встроенная кнопка недоступна, менеджер можно открыть из панели Firefox.

### Как проверяется лимит

Расширение использует сохранённую сессию каждого аккаунта, не подменяя cookie видимой вкладки:

```text
снимок cookie → /api/auth/session → временный токен и ID
                                      ↓
                         /backend-api/wham/usage
```

Ответные `Set-Cookie` удаляются до обработки Firefox, временный токен отдельно не сохраняется. Результат кэшируется на 10 минут и автоматически обновляется каждые 30 минут. Семидневное окно определяется по длительности около 604 800 секунд, независимо от того, в каком поле ответа оно находится. Внутренние endpoints ChatGPT могут измениться без предупреждения.

### Импорт, экспорт и безопасность

Импорт принимает массив cookie Firefox/Cookie Editor или общий JSON, экспортированный расширением. Принимаются только cookie `chatgpt.com` и его поддоменов.

Cookie авторизации и экспортированный JSON равнозначны паролю. Используйте расширение только для аккаунтов, к которым у вас есть разрешённый доступ. Не публикуйте cookie, токены, HTML ChatGPT, ID аккаунтов, email или незамазанные заголовки запросов. При утечке немедленно завершите активные сессии ChatGPT.

Удаление аккаунта стирает его снимок из `browser.storage.local`, а удаление расширения — его локальное хранилище. Ранее экспортированные файлы при этом не отзываются. Хранилище расширения не защищено отдельным мастер-паролем и не синхронизируется самим расширением.

### Конфиденциальность

Расширение хранит локально явно сохранённые cookie, имя и email профиля, служебные даты и кэш результата проверки. Оно обращается к `chatgpt.com` и разрешённым поддоменам, а для показа штатного буквенного аватара браузер может загрузить сохранённый URL вида `https://cdn.auth0.com/avatars/xx.png`. Расширение ничего не отправляет разработчику. Экспорт выполняется только по действию пользователя.

### Разработка и участие

```sh
bun install
bun run check
bun run lint
bun run build
```

Сборка создаёт ZIP в `web-ext-artifacts/`; компиляция исходников не требуется. Приветствуются небольшие исправления, переводы, улучшения доступности и безопасности. Сохраняйте совместимость с Firefox Manifest V3, не добавляйте телеметрию, удалённый код или облачное хранение, а новые строки добавляйте в обе локали. В тестах и снимках используйте только вымышленные данные.

Об уязвимостях сообщайте через приватный GitHub Security Advisory. Если приватные отчёты недоступны, создайте публичный issue только с просьбой о закрытом канале связи, без деталей и секретов. Поддерживается последняя версия ветки `1.0.x`.

### Технические заметки

Кнопка ищет штатный элемент временного чата, имеет резервное фиксированное положение и повторно монтируется после React-навигации через `MutationObserver`. Меню находится в закрытом Shadow DOM и использует Popover API, чтобы стили и модальные окна ChatGPT его не ломали. Полный снимок HTML намеренно не хранится: он может содержать действующие токены и другие данные сессии.

### Версия 1.0.0

Первый публичный релиз: мультиаккаунт на локальных снимках cookie, изолированная проверка лимитов, светлая и тёмная темы, русский и английский интерфейс, импорт/экспорт JSON и инструменты управления аккаунтами.

### Примечание о вайбкоде

Проект создан методом вайбкодинга с помощью ИИ — простите возможные шероховатости. Автотесты и ручное ревью есть, но помощь ИИ не заменяет аудит безопасности, особенно для кода, работающего с cookie авторизации.

Это независимый общественный проект, не связанный с OpenAI и не одобренный ею. Название ChatGPT используется только для описания совместимости. Лицензия: [MIT](LICENSE).

---

## English

An unofficial, local-first Firefox extension for switching between your own ChatGPT accounts and checking each account's available usage in the background.

### Features

- An account button below **Temporary Chat** on `chatgpt.com`.
- Local cookie snapshots and one-click account switching.
- Exact letter avatars from `cdn.auth0.com`, whose URLs ChatGPT stores in the profile cookie; color analysis and fallback colors are used only when no image is available.
- Remaining capacity first: **“Available 83%”**, followed by **“Used 17%”**.
- Background checks for every saved account without visibly switching tabs.
- Search, rename, delete, JSON import/export, automatic refresh, and Firefox Containers.
- Native Firefox localization in English and Russian.
- No telemetry, analytics, remote code, or third-party servers.

### Install and use

Firefox 142 or newer is required.

1. Download the ZIP from the [latest release](https://github.com/goendguys/chatgpt-multi-account-firefox/releases/latest) or clone this repository.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on** and choose `manifest.json`.
4. Reload an already-open ChatGPT tab once.
5. Select **Add this account**, then sign in to other accounts and save them the same way.

Temporary add-ons are removed after Firefox restarts. A permanent public release must be signed through Mozilla Add-ons. The Firefox toolbar popup remains available as a fallback manager.

### Usage checks

The extension uses each saved session without replacing cookies in the visible tab:

```text
cookie snapshot → /api/auth/session → temporary token and account ID
                                             ↓
                                /backend-api/wham/usage
```

Response `Set-Cookie` headers are removed before Firefox processes them, and temporary tokens are not stored separately. Results are cached for 10 minutes and refreshed every 30 minutes. A seven-day window is identified by its approximately 604,800-second duration rather than its field position. These internal ChatGPT endpoints may change without notice.

### Import, export, and security

Import accepts a Firefox/Cookie Editor array or a multi-account JSON file exported by the extension. Only cookies for `chatgpt.com` and its subdomains are accepted.

Authentication cookies and exported JSON are equivalent to passwords. Use the extension only with accounts you are authorized to access. Never publish cookies, tokens, copied ChatGPT HTML, account IDs, email addresses, or unredacted request headers. Revoke active ChatGPT sessions immediately after any credential exposure.

Deleting an account removes its snapshot from `browser.storage.local`; removing the extension removes its local storage. Previously exported files are not revoked. Extension storage has no separate master password and is not synchronized by the extension.

### Privacy

The extension stores explicitly saved cookies, profile name and email, maintenance timestamps, and cached usage results locally. It communicates with `chatgpt.com` and permitted subdomains; to display the standard letter avatar, the browser may load a stored URL such as `https://cdn.auth0.com/avatars/xx.png`. The extension sends nothing to the developer. Export happens only after an explicit user action.

### Development and contributing

```sh
bun install
bun run check
bun run lint
bun run build
```

The build creates a ZIP in `web-ext-artifacts/`; no source compilation is required. Focused fixes, translations, accessibility improvements, and security hardening are welcome. Keep Firefox Manifest V3 compatibility, add no telemetry, remote code, or cloud storage, and add user-facing strings to both locales. Use fictional data in tests and screenshots.

Report vulnerabilities through a private GitHub Security Advisory. If private reporting is unavailable, open a public issue that only requests a private contact channel and contains no details or secrets. Only the latest `1.0.x` release is supported.

### Implementation notes

The launcher looks for ChatGPT's Temporary Chat control, has a fixed-position fallback, and remounts after React navigation through a `MutationObserver`. The menu lives in a closed Shadow DOM and uses the Popover API so site styles and modal dialogs do not break it. A full copied HTML snapshot is intentionally not stored because it may contain active tokens and other session data.

### Version 1.0.0

The first public release includes local cookie-snapshot account switching, isolated usage checks, light and dark themes, English and Russian localization, JSON import/export, and account-management tools.

### Vibe-coding note

This project was vibe-coded with AI assistance—sorry for any rough edges. Automated checks and manual review are included, but AI assistance is not a substitute for a security audit, especially for code that handles authentication cookies.

This is an independent community project and is not affiliated with or endorsed by OpenAI. “ChatGPT” is used only to describe compatibility. License: [MIT](LICENSE).
