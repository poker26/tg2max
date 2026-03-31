# tg2max

Отдельный сервис для переноса постов из Telegram-канала в Max через Bot API (`platform-api.max.ru`), без зависимости от `MiniFarm`.

## Что делает

- импортирует тексты постов из Telegram в таблицу `channel_posts`
- импортирует фото и видео из Telegram (включая альбомы) в MinIO и связывает их с исходным постом в `media_uploads`
- публикует неперенесенные посты в Max и ведет лог в `crosspost_log`
- для постов с фото загружает изображение в MAX через `POST /uploads?type=image` и отправляет вложением

## Быстрый старт

1. Скопировать `.env.example` в `.env` и заполнить переменные.
2. Установить зависимости:
   - `npm install`
3. Прогнать миграции:
   - `npm run migrate`

После обновлений кода всегда повторно запускайте `npm run migrate`, чтобы применялись новые поля в `media_uploads`.

## Команды

- `npm run tg:import:posts -- @channel`
- `npm run tg:import:media -- @channel`
- `npm run crosspost:max -- @channel`
- `npm run crosspost:max:dry -- @channel`
- `npm run crosspost:max:publish -- @channel`
- `npm run web` — простая web-страница для запуска тестового/полного экспорта и просмотра логов

Важно: канал Telegram берётся только из CLI-аргумента (`@channel`) или из поля web-формы. Из `.env` канал не читается.
Web-режим запускает полный пайплайн (импорт + публикация), а не `--skip-import`.

## PM2 (постоянный web-процесс)

Добавлен файл `ecosystem.config.cjs` для запуска web UI как постоянного сервиса.

На сервере:

- `pm2 start ecosystem.config.cjs`
- `pm2 save`
- `pm2 startup`

Проверка:

- `pm2 status`
- `pm2 logs tg2max-web --lines 100`

Опционально можно явно задать чат назначения:

- `npm run crosspost:max -- @channel --max-chat-id -123456789`

## Безопасность для MiniFarm

Этот репозиторий полностью автономный:

- отдельный `.env`
- отдельные скрипты
- отдельные миграции
- не требует изменений в `MiniFarm`
