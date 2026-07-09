# Разделение PWA и клиентской формы актов

Версия: AKT-PWA-2026-07-09-23-SEPARATE-CLIENT-NO-CONFLICT

Что сделано:

- Внутреннее приложение актов живёт отдельно в `/acts/`.
- PWA-манифест актов: `/acts/manifest.webmanifest`.
- Service worker актов: `/acts/sw.js`, scope только `/acts/`.
- Клиентская форма вынесена из PWA: `/act-client.html`.
- Клиентская форма НЕ содержит `<link rel="manifest">`, НЕ регистрирует service worker и НЕ показывает кнопку установки.
- Старый путь `/acts/akt-client.html?id=...` оставлен как редирект на `/act-client.html?id=...`, чтобы старые ссылки не умерли.
- Корневой `/sw.js` очищен и не перехватывает `/acts/`, `/doska/` и `/act-client.html`.

Рабочие ссылки после деплоя:

- `/acts/` — внутреннее приложение актов, установка PWA отсюда.
- `/acts/akt-create.html` — создание ссылки клиенту.
- `/acts/akt-journal.html` — журнал.
- `/acts/akt-settings.html` — админка.
- `/act-client.html?id=...` — публичная форма клиента без PWA.

После заливки лучше один раз открыть в Edge:

1. `https://skladmanagerweb.vercel.app/acts/`
2. `Ctrl + F5`
3. Если старый service worker мешает: DevTools → Application → Service Workers → Unregister, потом Clear site data.
