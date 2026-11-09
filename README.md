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

Главная страница — канбан-дашборд в эстетике Apple (iOS HIG): тёмная тема, матовое стекло
(`backdrop-blur-xl`, `bg-zinc-900/60`), крупные скругления и минимум визуального шума.

- **Динамические колонки.** Разделы не захардкожены: канбан строится по уникальным значениям
  `category` активных заметок (`deleted_at is null`). Базовые разделы (🎵 Музыка, 💼 Бизнес,
  ⏱ Задачи, 💡 Мысли) идут первыми, новые («Спорт», «Дом») — следом по алфавиту.
- **Чипы подкатегорий.** Внутри каждой колонки — фильтры по `subcategory` со счётчиками
  («Все», «Мотив 4», «Текст 2»).
- **Корзина.** Переключатель «Канбан / Корзина» в шапке и счётчик удалённых заметок. У карточки
  в корзине две кнопки: «Восстановить» и «Удалить навсегда» (вместе с аудио из Storage).
- **Карточки.** Заголовок, время, тег подкатегории, очищенный текст, бейдж дедлайна у задач,
  компактный плеер и кнопки «выполнено» / «в корзину».
- На мобильных колонки переключаются табами, на десктопе — сетка по числу разделов.

Интерфейс не обращается к Supabase напрямую: чтение и мутации идут через API-роуты на
service_role-ключе, поэтому RLS-политики для роли `anon` на `voice_notes` не нужны.

## Схема

Колонки, которые используют канбан и корзина:

```sql
alter table public.voice_notes
  add column if not exists subcategory text,
  add column if not exists deleted_at timestamptz;
```

`deleted_at is null` — заметка в канбане, иначе она лежит в корзине.

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

## Структура

```
src/
├── app/
│   ├── api/
│   │   ├── voice-inbox/route.ts     # POST: аудио → Storage → Deepgram → DeepSeek → БД
│   │   └── voice-notes/
│   │       ├── route.ts             # GET: активные заметки + корзина
│   │       └── [id]/route.ts        # PATCH: статус / корзина, DELETE: Storage + строка
│   ├── layout.tsx
│   ├── page.tsx                     # дашборд: динамические колонки, чипы, корзина
│   └── globals.css
└── lib/
    ├── api-error.ts                 # читаемый текст ошибок Supabase
    └── supabase.ts                  # браузерный (anon) и серверный (service_role) клиенты
```

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

