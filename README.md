# tg2max

Отдельный сервис для переноса постов из Telegram-канала в Max через Bot API (`platform-api.max.ru`), без зависимости от `MiniFarm`.

## Что делает

- импортирует тексты постов из Telegram в таблицу `channel_posts`
- импортирует фото в MinIO и сохраняет ссылки в `media_uploads`
- импортирует фото и видео из Telegram (включая альбомы) и связывает их с исходным постом
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

Опционально можно явно задать чат назначения:

- `npm run crosspost:max -- @channel --max-chat-id -123456789`

## Безопасность для MiniFarm

Этот репозиторий полностью автономный:

- отдельный `.env`
- отдельные скрипты
- отдельные миграции
- не требует изменений в `MiniFarm`
