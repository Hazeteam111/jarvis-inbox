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

Главная страница — канбан-дашборд личного ассистента:

- четыре колонки: 🎵 Музыка & Мотивы, 💼 Бизнес & Идеи, ⏱ Задачи, 💡 Мысли & Дневник;
- компактная кнопка записи в шапке (таймер и индикация записи) и кнопка обновления списка;
- карточки: заголовок, время («Сегодня, 14:30»), очищенный текст, бейдж дедлайна у задач,
  мини-плеер у музыки, переключатель статуса `inbox` → `done`;
- на мобильных колонки переключаются табами, на десктопе — четыре колонки в ряд.

Данные читаются браузерным клиентом (`getSupabaseBrowserClient`), а статус обновляется
через `UPDATE`, поэтому для таблицы `voice_notes` нужны RLS-политики на `SELECT` и `UPDATE`
для роли `anon`:

```sql
alter table public.voice_notes enable row level security;

create policy "voice_notes read" on public.voice_notes
  for select to anon using (true);

create policy "voice_notes update status" on public.voice_notes
  for update to anon using (true) with check (true);
```

> Такие политики открывают чтение и смену статуса всем, у кого есть anon-ключ. Для личного
> приложения на localhost это приемлемо; при публикации добавьте Supabase Auth и ограничьте
> политики по `auth.uid()`.

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
│   ├── api/voice-inbox/route.ts   # POST: аудио → Storage → Deepgram → DeepSeek → БД
│   ├── layout.tsx
│   ├── page.tsx                   # канбан-дашборд: запись, фильтры, карточки
│   └── globals.css
└── lib/
    └── supabase.ts                # браузерный (anon) и серверный (service_role) клиенты
```

## API

`POST /api/voice-inbox`

- Тело: `multipart/form-data`
- Поле `audio` — аудиофайл (обязательное, до 25 MB).
- Ответ: `{ "status": "ok" }`; ошибки — `{ "status": "error", "error": "…" }`.

```bash
curl -X POST http://localhost:3000/api/voice-inbox -F "audio=@note.webm"
```

