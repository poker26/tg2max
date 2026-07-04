# TG master -> MAX mirror: Runbook

Документ для прод-эксплуатации `sync-worker` в репозитории `tg2max`.

## 1) Цель и SLA

- Синхронизация: `Telegram (master)` -> `MAX (mirror)`.
- Режим: near-realtime polling.
- Целевые SLA:
  - новые посты в MAX: до 60 сек;
  - обновления постов: до 120 сек;
  - удаления постов: до 120 сек;
  - отсутствие зависших `pending/processing` дольше 10 минут.

## 2) Что уже должно быть готово

- Рабочий `MAX_BOT_TOKEN`, `MAX_TARGET_CHAT_ID`.
- Рабочие `TG_API_ID`, `TG_API_HASH`, `TG_SESSION`.
- Доступ к Supabase (миграции/чтение/запись).
- MinIO (если нужны вложения фото/видео).
- Репозиторий `tg2max` на сервере.

## 3) Обновление кода и миграции

```bash
cd /path/to/tg2max
```

```bash
git pull
```

```bash
npm install
```

```bash
npm run migrate
```

После миграции должны существовать таблицы:

- `sync_cursor`
- `message_map`
- `sync_events`
- `sync_locks`

## 4) Настройка `.env` для sync-worker

Минимальный блок:

```env
SYNC_SOURCE_CHANNEL=@your_channel
MAX_TARGET_CHAT_ID=-123456789
MAX_BOT_TOKEN=...
MAX_API_BASE_URL=https://platform-api.max.ru

SYNC_POLL_INTERVAL_MS=30000
SYNC_POLL_LIMIT=200
SYNC_EVENT_BATCH_SIZE=50
SYNC_LOCK_TTL_MS=120000
SYNC_LOCK_NAME=tg_master_to_max_worker
SYNC_STALE_PROCESSING_MS=600000
SYNC_MAX_ATTEMPTS=8
SYNC_RETRY_BASE_DELAY_MS=2000
SYNC_DELETE_FALLBACK_MODE=tombstone
```

Рекомендации для старта:

- `SYNC_POLL_INTERVAL_MS=30000`
- `SYNC_POLL_LIMIT=200`
- `SYNC_EVENT_BATCH_SIZE=50`

## 5) Запуск в PM2

Если используете `ecosystem.config.cjs`:

```bash
pm2 start ecosystem.config.cjs --only tg2max-sync
```

```bash
pm2 save
```

Проверка:

```bash
pm2 status
```

```bash
pm2 logs tg2max-sync --lines 100
```

Ожидаемые признаки в логах:

- успешное подключение MAX бота;
- циклы `iteration done` с `collectStats` и `dispatchStats`.

## 6) Smoke test (тестовый канал)

1. Опубликовать новый пост в тестовом Telegram-канале.
2. Проверить появление поста в MAX в течение 60 сек.
3. Отредактировать текст поста в Telegram и проверить обновление в MAX.
4. Удалить пост в Telegram и проверить удаление/тумбстоун в MAX.

## 7) Операционные проверки (SQL)

### 7.1 Глубина очереди

```sql
select status, count(*) as count
from sync_events
group by status
order by status;
```

### 7.2 Зависшие processing

```sql
select id, source_channel_id, source_message_id, event_type, processing_started_at, attempt_count
from sync_events
where status = 'processing'
  and processing_started_at < now() - interval '10 minutes'
order by processing_started_at asc;
```

### 7.3 Ошибки (dead-letter)

```sql
select id, source_message_id, event_type, attempt_count, last_error, updated_at
from sync_events
where status = 'error'
order by updated_at desc
limit 100;
```

### 7.4 Отставание курсора

```sql
select source_channel_id, last_message_id, last_scan_at, updated_at
from sync_cursor
order by updated_at desc;
```

### 7.5 Карта соответствий TG -> MAX

```sql
select source_message_id, target_chat_id, target_message_id, deleted_at, updated_at
from message_map
where source_channel_id = '@your_channel'
order by source_message_id desc
limit 100;
```

## 8) Алерты и пороги

Минимальный набор:

- `sync_events.status='error'` > 0 за последние 15 минут.
- `processing` старше 10 минут > 0.
- нет обновления `sync_cursor.last_scan_at` более 2 интервалов polling.
- доля неуспешных событий > 10% за 15 минут.

## 9) Диагностика типовых проблем

- `MAX API ... 400/500`:
  - проверить формат payload, токен, `MAX_TARGET_CHAT_ID`;
  - проверить лимиты/доступность MAX API.
- много `error` по медиа:
  - проверить MinIO доступ, object keys, размер/тип файлов;
  - проверить `uploadMediaToMax` ошибки в логах.
- дубляжи:
  - проверить несколько запущенных инстансов;
  - проверить lock (`sync_locks`) и TTL.
- пропуски событий:
  - проверить `SYNC_POLL_LIMIT` (слишком малое окно);
  - увеличить `SYNC_POLL_LIMIT` и временно уменьшить `SYNC_POLL_INTERVAL_MS`.

## 10) Rollback

Быстрый rollback в batch-режим:

1. Остановить воркер:

```bash
pm2 stop tg2max-sync
```

2. Вернуться к одноразовому pipeline:

```bash
npm run crosspost:max -- @your_channel --max-chat-id -123456789
```

3. После стабилизации вернуть воркер и наблюдение.

## 11) Cutover в production

1. Прогон на тестовом канале минимум 24 часа.
2. Проверка SLA и отсутствие stuck events.
3. Включение в боевом канале.
4. Усиленный мониторинг первые 48 часов.
5. Фиксация baseline метрик (lag/error-rate/queue-depth).
