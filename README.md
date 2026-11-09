# Jarvis Voice Inbox

Личный ассистент: голосовые заметки → расшифровка → структурированные записи и задачи.

## Стек

- [Next.js 16](https://nextjs.org) — App Router, TypeScript, Turbopack
- [Tailwind CSS 4](https://tailwindcss.com)
- [Supabase](https://supabase.com) — БД и Storage (`@supabase/supabase-js`)
- [Deepgram](https://deepgram.com) — расшифровка аудио (`nova-3`, `@deepgram/sdk`)

## Статус

Рабочий конвейер: запись с микрофона → Supabase Storage → Deepgram (`nova-3`, ru) → DeepSeek → таблица `voice_notes`.

## Интерфейс

Главная страница — канбан-дашборд в эстетике Apple: тёмная тема, «живое» стекло
(`.glass`, `.surface`), крупные скругления и минимум визуального шума. Оформление взято из
проекта «ОБОРОТ» (`1c-sales`), токены и компоненты описаны в разделе «Дизайн-система».

- **Динамические колонки.** Разделы не захардкожены: канбан строится по уникальным значениям
  `category` активных заметок (`deleted_at is null`). Базовые разделы (🎵 Музыка, 💼 Бизнес,
  ⏱ Задачи, 💡 Мысли) идут первыми, новые («Спорт», «Дом») — следом по алфавиту.
- **Чипы подкатегорий.** Внутри каждой колонки — фильтры по `subcategory` со счётчиками
  («Все», «Мотив 4», «Текст 2»).
- **Корзина.** Переключатель «Канбан / Корзина» в шапке и счётчик удалённых заметок. У карточки
  в корзине две кнопки: «Восстановить» и «Удалить навсегда» (вместе с аудио из Storage).
- **Карточки.** Заголовок, время, тег подкатегории, очищенный текст, бейдж дедлайна у задач,
  компактный плеер и кнопки «выполнено» / «в корзину».
- **Настройки Telegram.** Шестерёнка в шапке открывает модалку: токен бота, chat_id, тумблер
  «Отправлять ежедневный отчёт», время вечернего отчёта по Москве (`summary_time`, по умолчанию
  `21:30`) и кнопка «Отправить сейчас» (крон с `?force=true`).
- На мобильных колонки переключаются табами, на десктопе — сетка по числу разделов.

Интерфейс не обращается к Supabase напрямую: чтение и мутации идут через API-роуты на
service_role-ключе, поэтому RLS-политики для роли `anon` на `voice_notes` не нужны.

## Дизайн-система

Все токены живут в `src/app/globals.css`: в Tailwind 4 конфигом является блок `@theme`,
отдельный `tailwind.config` не нужен.

| Токен | Значение | Утилиты |
| --- | --- | --- |
| `--bg` | `#050507` | `bg-bg` |
| `--panel` / `--panel-2` | `rgb(255 255 255 / .062)` / `.045` | `bg-panel`, `bg-panel-2` |
| `--stroke` / `--stroke-2` | `rgb(255 255 255 / .10)` / `.20` | `border-stroke`, `border-stroke-2` |
| `--text` | `#f5f5f7` | `text-ink` |
| `--muted` / `--dim` | `rgb(235 235 245 / .60)` / `.36` | `text-muted`, `text-dim` |
| `--apple-green` / `--apple-red` | `#30D158` / `#FF453A` | `bg-apple-green`, `text-apple-red` |
| `--apple-blue` / `--apple-yellow` | `#0A84FF` / `#FFD60A` | `bg-apple-blue`, `text-apple-yellow` |
| `--r` / `--rs` / `--r-sheet` | `22px` / `15px` / `28px` | `rounded-card`, `rounded-chip`, `rounded-sheet` |
| `--spring` / `--soft-out` | `cubic-bezier(.34,1.56,.64,1)` / `(.22,1,.36,1)` | `ease-spring`, `ease-soft` |

Шрифты подключены через `next/font/google` в `layout.tsx`: `Unbounded` (заголовки, счётчики,
бренд — `font-display`) и `Manrope` (интерфейс — `font-sans`), оба с кириллицей.

Готовые компоненты (там же, в `@layer components`):

- `.glass` / `.glass-lite` — матовые панели (шапка, плашки, группа настроек);
- `.surface` + `.surface-hover` — карточки и колонки (заливка 6.2 %, светлая кромка, подъём);
- `.btn`, `.btn-prime`, `.btn-danger`, `.btn-sm`, `.icon-btn` — пружинные кнопки-«таблетки»;
- `.chip`, `.chip-on`, `.seg`, `.seg-btn`, `.seg-btn-on` — фильтры и сегмент-контролы;
- `.field-label`, `.input`, `.hint`, `.switch`, `.switch-knob` — форма настроек;
- `.ovl`, `.sheet`, `.grab`, `.sheet-x` — модалка Telegram как bottom sheet на iOS;
- `.app-aurora` + `.app-glow-*` — три плавающих световых пятна и зерно 3.8 % поверх фона;
- `.anim-rise` (каскад карточек), `.anim-breathe` (запись) — микроанимации.

Совместимость: нейтральная шкала `zinc` переопределена на палитру проекта, поэтому старые
классы (`bg-zinc-900/60`, `text-zinc-400`) визуально совпадают с токенами. Новый код пишите
токенами (`bg-panel`, `border-stroke`, `text-muted`).

## Схема

Колонки, которые используют канбан и корзина:

```sql
alter table public.voice_notes
  add column if not exists subcategory text,
  add column if not exists deleted_at timestamptz;
```

`deleted_at is null` — заметка в канбане, иначе она лежит в корзине.

Настройки бота и расписания — одна строка `app_settings` (`id = 1`):

```sql
create table if not exists public.app_settings (
  id integer primary key default 1 check (id = 1),
  bot_token text,
  chat_id text,
  is_active boolean not null default false,
  summary_time text not null default '21:30',
  last_summary_date date,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id) values (1) on conflict (id) do nothing;
```

`summary_time` — «HH:mm» по Москве, `last_summary_date` — дата последней автоматической
отправки (защита от дублей), `is_active` — тумблер ежедневного отчёта.

## Запуск

```bash
npm install
npm run dev
```

Откройте [http://localhost:3000](http://localhost:3000).

## Переменные окружения

Скопируйте значения в `.env.local` (файл в `.gitignore`, в репозиторий не попадает):

| Переменная | Назначение |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | URL проекта Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Публичный anon-ключ (чтение по RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role-ключ, только сервер (запись) |
| `DEEPGRAM_API_KEY` | Ключ Deepgram для распознавания речи (`nova-3`) |
| `DEEPSEEK_API_KEY` | Ключ DeepSeek для обработки текста |
| `CRON_SECRET` | Необязательный секрет Vercel Cron: если задан, крон требует `Authorization: Bearer …` |

## Структура

```
src/
├── app/
│   ├── api/
│   │   ├── voice-inbox/route.ts      # POST: аудио → Storage → Deepgram → DeepSeek → БД
│   │   ├── voice-notes/
│   │   │   ├── route.ts              # GET: активные заметки + корзина
│   │   │   └── [id]/route.ts         # PATCH: статус / корзина, DELETE: Storage + строка
│   │   ├── settings/telegram/route.ts   # GET/POST: bot_token, chat_id, is_active, summary_time
│   │   └── cron/daily-summary/route.ts  # GET/POST: вечерний отчёт (?force=true)
│   ├── layout.tsx
│   ├── page.tsx                      # дашборд: колонки, чипы, корзина, модалка Telegram
│   └── globals.css
└── lib/
    ├── api-error.ts                  # читаемый текст ошибок Supabase
    ├── supabase.ts                   # браузерный (anon) и серверный (service_role) клиенты
    └── telegram.ts                   # app_settings, московское время, отправка в Bot API
```

`vercel.json` — расписание крона (`0,30 * * * *`), см. «Деплой и крон».

## API

`POST /api/voice-inbox`

- Тело: `multipart/form-data`
- Поле `audio` — аудиофайл (обязательное, до 25 MB).
- Ответ: `{ "status": "ok" }`; ошибки — `{ "status": "error", "error": "…" }`.

```bash
curl -X POST http://localhost:3000/api/voice-inbox -F "audio=@note.webm"
```

`GET /api/voice-notes`

- Ответ: `{ "status": "ok", "data": { "active": [...], "trash": [...] } }`.

`PATCH /api/voice-notes/:id`

- `{ "status": "done" }` / `{ "status": "inbox" }` — переключение статуса карточки;
- `{ "deleted": true }` — в корзину (`deleted_at = now()`), `{ "deleted": false }` — восстановить.

`DELETE /api/voice-notes/:id`

- Удаляет объект из бакета `voice-records`, затем строку из `voice_notes`.

```bash
curl -X PATCH http://localhost:3000/api/voice-notes/<id> \
  -H "Content-Type: application/json" -d "{\"deleted\":true}"

curl -X DELETE http://localhost:3000/api/voice-notes/<id>
```

`GET /api/settings/telegram`

- Ответ: `{ "status": "ok", "data": { "bot_token", "chat_id", "is_active", "summary_time", "last_summary_date" } }`.

`POST /api/settings/telegram`

- Тело: `{ "bot_token": "…", "chat_id": "…", "is_active": true, "summary_time": "21:30" }` —
  можно передать любое подмножество полей.
- `summary_time` валидируется как `HH:mm`; пустое или некорректное значение превращается в `21:30`.
- Включить `is_active` без токена и chat_id нельзя — вернётся 400.

`GET|POST /api/cron/daily-summary[?force=true]`

- `?force=true` — «Отправить сейчас»: игнорирует расписание, тумблер `is_active` и отметку
  `last_summary_date`; сама дата отправки при этом не перезаписывается.
- Без параметра проверяет `is_active`, московское время (окно 30 минут после `summary_time`)
  и `last_summary_date` — повторно за день отчёт не уходит.
- Статусы: `ok`, `skipped` (`not_configured`, `inactive`, `not_scheduled_time`,
  `already_sent_today`), `error`.

```bash
curl -X POST http://localhost:3000/api/settings/telegram \
  -H "Content-Type: application/json" \
  -d "{\"bot_token\":\"123:ABC\",\"chat_id\":\"123456789\",\"is_active\":true,\"summary_time\":\"21:30\"}"

curl "http://localhost:3000/api/cron/daily-summary?force=true"
```

## Деплой и крон

`vercel.json` запускает `/api/cron/daily-summary` каждые 30 минут (`0,30 * * * *`). На плане
Vercel Hobby такие частые кроны недоступны (разрешён один запуск в сутки) — там используйте
`30 18 * * *` (18:30 UTC = 21:30 МСК) или внешний планировщик с вызовом
`/api/cron/daily-summary`. Если задан `CRON_SECRET`, Vercel сам пришлёт
`Authorization: Bearer <secret>`; ручная отправка из интерфейса секрет не требует.

> У роутов нет собственной аутентификации: `bot_token` хранится в `app_settings` и отдаётся
> интерфейсу. Не выкладывайте дашборд в публичный доступ без пароля/прокси.


