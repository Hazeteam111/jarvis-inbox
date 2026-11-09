"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase";

/**
 * Дашборд «Jarvis Inbox»: канбан из четырёх колонок и компактная запись аудио
 * в шапке. Заметки читаются напрямую из Supabase браузерным клиентом
 * (`getSupabaseBrowserClient`, anon key — доступ ограничен RLS-политиками).
 */

type Category = "music" | "business" | "task" | "thought";

type NoteStatus = "inbox" | "done";

type StatusFilter = "all" | "inbox" | "done";

type Phase = "idle" | "requesting" | "recording" | "processing" | "done" | "error";

type VoiceNote = {
  id: string;
  audio_url: string | null;
  raw_transcript: string | null;
  title: string | null;
  category: string | null;
  cleaned_text: string | null;
  action_date: string | null;
  status: string | null;
  created_at: string | null;
};

type VoiceInboxResponse =
  | { status: "ok"; data: VoiceNote }
  | { status: "error"; error: string };

type ColumnMeta = {
  id: Category;
  title: string;
  shortTitle: string;
  emoji: string;
  activeChip: string;
  gradient: string;
};

const VOICE_NOTES_TABLE = "voice_notes";
const VOICE_INBOX_ENDPOINT = "/api/voice-inbox";
const AUDIO_FIELD = "audio";
const AUDIO_FILE_NAME = "record.m4a";

/** Поля таблицы `voice_notes`, совпадают с ответом API. */
const NOTE_FIELDS =
  "id, audio_url, raw_transcript, title, category, cleaned_text, action_date, status, created_at";

/** Колонки канбана в порядке отображения. */
const COLUMNS: ColumnMeta[] = [
  {
    id: "music",
    title: "Музыка & Мотивы",
    shortTitle: "Музыка",
    emoji: "🎵",
    activeChip: "border-violet-400/40 bg-violet-500/15 text-violet-200",
    gradient: "from-violet-400/60",
  },
  {
    id: "business",
    title: "Бизнес & Идеи",
    shortTitle: "Бизнес",
    emoji: "💼",
    activeChip: "border-amber-400/40 bg-amber-500/15 text-amber-200",
    gradient: "from-amber-400/60",
  },
  {
    id: "task",
    title: "Задачи",
    shortTitle: "Задачи",
    emoji: "⏱",
    activeChip: "border-sky-400/40 bg-sky-500/15 text-sky-200",
    gradient: "from-sky-400/60",
  },
  {
    id: "thought",
    title: "Мысли & Дневник",
    shortTitle: "Мысли",
    emoji: "💡",
    activeChip: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200",
    gradient: "from-emerald-400/60",
  },
];

/** Порядок важен: первый поддерживаемый браузером тип и будет использован. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

const PHASE_TEXT: Record<Phase, string> = {
  idle: "",
  requesting: "Запрашиваем доступ к микрофону…",
  recording: "Идёт запись — нажмите «Стоп», когда закончите",
  processing: "Распознаём речь и раскладываем по колонкам…",
  done: "Готово: заметка уже в канбане",
  error: "Не получилось обработать запись",
};

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "Все" },
  { id: "inbox", label: "В работе" },
  { id: "done", label: "Выполнено" },
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }

  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function isCategory(value: string | null): value is Category {
  return (
    value === "music" || value === "business" || value === "task" || value === "thought"
  );
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** «Сегодня, 14:30», «Вчера, 09:12», иначе «10 нояб., 14:30». */
function formatNoteTime(value: string | null): string {
  if (!value) {
    return "Без даты";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Без даты";
  }

  const time = date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);

  if (dayDiff === 0) {
    return `Сегодня, ${time}`;
  }

  if (dayDiff === 1) {
    return `Вчера, ${time}`;
  }

  const day = date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

  return `${day}, ${time}`;
}

/** Бейдж дедлайна для задач: подпись и признак просрочки. */
function formatDeadline(value: string): { label: string; overdue: boolean } {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return { label: value, overdue: false };
  }

  return {
    label: date.toLocaleString("ru-RU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
    overdue: date.getTime() < Date.now(),
  };
}

function noteTitle(note: VoiceNote): string {
  return (note.title ?? "").trim() || "Без названия";
}

function noteText(note: VoiceNote): string {
  return ((note.cleaned_text ?? "") || (note.raw_transcript ?? "")).trim();
}

function describeLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/row-level security|permission denied/i.test(message)) {
    return "Supabase не отдаёт заметки: для таблицы voice_notes нет RLS-политики SELECT для anon-ключа.";
  }

  return `Не удалось загрузить заметки: ${message}`;
}

function describeToggleError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/row-level security|permission denied/i.test(message)) {
    return "Supabase не разрешил обновление: нужна RLS-политика UPDATE для таблицы voice_notes.";
  }

  return `Не удалось обновить статус: ${message}`;
}

function describeMicrophoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Доступ к микрофону запрещён. Разрешите его в настройках браузера и попробуйте снова.";
    }

    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "Микрофон не найден. Подключите устройство записи.";
    }

    if (error.name === "NotReadableError") {
      return "Микрофон занят другим приложением.";
    }
  }

  return error instanceof Error
    ? error.message
    : "Не удалось начать запись с микрофона.";
}

export default function Home() {
  const [notes, setNotes] = useState<VoiceNote[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [activeColumn, setActiveColumn] = useState<Category>("music");
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const unmountedRef = useRef(false);

  const isRecording = phase === "recording";
  const isProcessing = phase === "requesting" || phase === "processing";

  /** Чтение всех заметок из `voice_notes`: свежие сверху. */
  const loadNotes = useCallback(async () => {
    setIsRefreshing(true);

    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from(VOICE_NOTES_TABLE)
        .select(NOTE_FIELDS)
        .order("created_at", { ascending: false });

      if (error) {
        throw error;
      }

      setNotes((data ?? []) as VoiceNote[]);
      setLoadError(null);
      setLastLoadedAt(
        new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
      );
    } catch (error) {
      setLoadError(describeLoadError(error));
    } finally {
      setHasLoaded(true);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  // Тикающий таймер записи.
  useEffect(() => {
    if (!isRecording) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setSeconds((value) => value + 1);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isRecording]);

  // Статус «Готово» живёт пару секунд, затем шапка возвращается в покой.
  useEffect(() => {
    if (phase !== "done") {
      return;
    }

    const timeoutId = window.setTimeout(() => setPhase("idle"), 4000);

    return () => window.clearTimeout(timeoutId);
  }, [phase]);

  // Уборка при размонтировании: микрофон и стрим.
  // unmountedRef сбрасывается на входе — в dev StrictMode эффекты запускаются дважды.
  useEffect(() => {
    unmountedRef.current = false;

    return () => {
      unmountedRef.current = true;

      const recorder = recorderRef.current;

      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  /** Переключение статуса карточки inbox ⇄ done (оптимистично, с откатом). */
  async function toggleStatus(note: VoiceNote) {
    const nextStatus: NoteStatus = note.status === "done" ? "inbox" : "done";

    setActionError(null);
    setNotes((prev) =>
      prev.map((item) => (item.id === note.id ? { ...item, status: nextStatus } : item)),
    );
    setPendingIds((prev) => [...prev, note.id]);

    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from(VOICE_NOTES_TABLE)
        .update({ status: nextStatus })
        .eq("id", note.id);

      if (error) {
        throw error;
      }
    } catch (error) {
      setNotes((prev) =>
        prev.map((item) => (item.id === note.id ? { ...item, status: note.status } : item)),
      );
      setActionError(describeToggleError(error));
    } finally {
      setPendingIds((prev) => prev.filter((id) => id !== note.id));
    }
  }

  /** Аудио → API → новая карточка сразу в своей колонке. */
  async function sendRecording(blob: Blob) {
    setPhase("processing");
    setRecordError(null);

    try {
      const formData = new FormData();
      formData.append(AUDIO_FIELD, blob, AUDIO_FILE_NAME);

      const response = await fetch(VOICE_INBOX_ENDPOINT, {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json().catch(() => null)) as VoiceInboxResponse | null;

      if (!response.ok) {
        const apiMessage = payload?.status === "error" ? payload.error : null;

        throw new Error(apiMessage ?? `Сервер ответил HTTP ${response.status}.`);
      }

      if (!payload || payload.status !== "ok" || !payload.data?.id) {
        throw new Error("Сервер вернул неожиданный ответ.");
      }

      if (unmountedRef.current) {
        return;
      }

      const created = payload.data;

      setNotes((prev) => [created, ...prev.filter((item) => item.id !== created.id)]);
      setStatusFilter("all");
      setActiveColumn(isCategory(created.category) ? created.category : "thought");
      setPhase("done");
    } catch (uploadError) {
      if (unmountedRef.current) {
        return;
      }

      setPhase("error");
      setRecordError(
        uploadError instanceof TypeError
          ? "Не удалось связаться с сервером. Проверьте, что приложение запущено, и повторите."
          : uploadError instanceof Error
            ? uploadError.message
            : "Неизвестная ошибка при обработке записи.",
      );
    }
  }

  async function startRecording() {
    setRecordError(null);
    setSeconds(0);

    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("error");
      setRecordError(
        "Браузер не даёт доступ к микрофону. Откройте страницу по HTTPS или на localhost.",
      );

      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setPhase("error");
      setRecordError("Браузер не поддерживает запись аудио (MediaRecorder).");

      return;
    }

    setPhase("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      if (unmountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());

        return;
      }

      streamRef.current = stream;

      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setPhase("error");
        setRecordError("Запись прервалась из-за ошибки микрофона.");
      };

      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        const chunks = chunksRef.current;
        chunksRef.current = [];

        if (chunks.length === 0) {
          if (!unmountedRef.current) {
            setPhase("error");
            setRecordError("Запись пустая — попробуйте ещё раз.");
          }

          return;
        }

        if (unmountedRef.current) {
          return;
        }

        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });

        void sendRecording(blob);
      };

      recorder.start();
      setPhase("recording");
    } catch (permissionError) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setPhase("error");
      setRecordError(describeMicrophoneError(permissionError));
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    recorderRef.current = null;

    if (recorder && recorder.state !== "inactive") {
      setPhase("processing");
      recorder.stop();

      return;
    }

    setPhase("idle");
  }

  function handleRecordClick() {
    if (isProcessing) {
      return;
    }

    if (isRecording) {
      stopRecording();

      return;
    }

    void startRecording();
  }

  const inboxCount = notes.filter((note) => note.status !== "done").length;
  const filterCounts: Record<StatusFilter, number> = {
    all: notes.length,
    inbox: inboxCount,
    done: notes.length - inboxCount,
  };

  const visibleNotes = useMemo(
    () =>
      notes.filter((note) =>
        statusFilter === "all"
          ? true
          : statusFilter === "done"
            ? note.status === "done"
            : note.status !== "done",
      ),
    [notes, statusFilter],
  );

  const groupedNotes = useMemo(() => {
    const grouped: Record<Category, VoiceNote[]> = {
      music: [],
      business: [],
      task: [],
      thought: [],
    };

    for (const note of visibleNotes) {
      const category = isCategory(note.category) ? note.category : "thought";
      grouped[category].push(note);
    }

    return grouped;
  }, [visibleNotes]);

  const statusLine = PHASE_TEXT[phase];

  return (
    <main className="relative flex min-h-dvh flex-1 flex-col bg-neutral-950 text-neutral-100">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(65%_100%_at_50%_0%,rgba(99,102,241,0.18),transparent_70%)]"
      />

      <header className="sticky top-0 z-20 border-b border-white/5 bg-neutral-950/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1700px] items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-6">
          <div className="mr-auto flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-gradient-to-br from-indigo-500/30 to-neutral-900 text-base"
            >
              🤖
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
                Jarvis Inbox
              </h1>
              <p className="hidden truncate text-[11px] text-neutral-500 sm:block">
                Голос → Deepgram nova-3 → DeepSeek → канбан
              </p>
            </div>
          </div>

          <RecordButton phase={phase} seconds={seconds} onClick={handleRecordClick} />

          <button
            type="button"
            onClick={() => void loadNotes()}
            disabled={isRefreshing}
            title="Обновить список заметок"
            aria-label="Обновить список заметок"
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-neutral-900 px-3 text-sm text-neutral-300 transition hover:border-white/20 hover:bg-neutral-800 disabled:opacity-60"
          >
            <RefreshIcon className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            <span className="hidden sm:inline">Обновить</span>
          </button>
        </div>

        {statusLine ? (
          <div className="mx-auto flex w-full max-w-[1700px] items-center gap-2 px-3 pb-2.5 text-[11px] text-neutral-500 sm:px-6 sm:text-xs">
            {isProcessing ? <Spinner className="h-3.5 w-3.5" /> : null}
            <span role="status" aria-live="polite" className="truncate">
              {statusLine}
            </span>
          </div>
        ) : null}
      </header>

      <div className="relative mx-auto w-full max-w-[1700px] flex-1 px-3 pb-10 sm:px-6">
        {recordError ? (
          <div
            role="alert"
            className="mt-3 flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-red-200"
          >
            <span className="flex-1">{recordError}</span>
            <button
              type="button"
              onClick={() => {
                setRecordError(null);
                setPhase("idle");
              }}
              aria-label="Скрыть сообщение об ошибке"
              className="shrink-0 text-red-300/80 transition hover:text-red-100"
            >
              ✕
            </button>
          </div>
        ) : null}

        {loadError ? (
          <div
            role="alert"
            className="mt-3 flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-amber-200 sm:flex-row sm:items-center"
          >
            <span className="flex-1">{loadError}</span>
            <button
              type="button"
              onClick={() => void loadNotes()}
              className="self-start rounded-full border border-amber-400/30 px-3 py-1 font-medium text-amber-100 transition hover:bg-amber-500/15 sm:self-auto"
            >
              Повторить
            </button>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-white/5 bg-neutral-900/70 p-0.5">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setStatusFilter(filter.id)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs font-medium transition",
                  statusFilter === filter.id
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-300",
                )}
              >
                {filter.label}
                <span className="ml-1.5 tabular-nums text-neutral-500">
                  {filterCounts[filter.id]}
                </span>
              </button>
            ))}
          </div>

          <p className="ml-auto hidden text-[11px] text-neutral-600 sm:block">
            {lastLoadedAt ? `обновлено ${lastLoadedAt}` : null}
          </p>
        </div>

        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] lg:hidden [&::-webkit-scrollbar]:hidden">
          {COLUMNS.map((column) => {
            const isActive = activeColumn === column.id;

            return (
              <button
                key={column.id}
                type="button"
                onClick={() => setActiveColumn(column.id)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                  isActive
                    ? column.activeChip
                    : "border-white/10 bg-neutral-900/60 text-neutral-400 hover:text-neutral-200",
                )}
              >
                <span aria-hidden>{column.emoji}</span>
                {column.shortTitle}
                <span className="tabular-nums opacity-70">
                  {groupedNotes[column.id].length}
                </span>
              </button>
            );
          })}
        </div>

        <Board
          hasLoaded={hasLoaded}
          groupedNotes={groupedNotes}
          activeColumn={activeColumn}
          pendingIds={pendingIds}
          onToggleStatus={toggleStatus}
        />

        {actionError ? (
          <div
            role="alert"
            className="mt-4 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200"
          >
            <span className="flex-1">{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="shrink-0 text-amber-300/80 transition hover:text-amber-100"
            >
              Закрыть
            </button>
          </div>
        ) : null}

        <p className="mt-6 text-center text-[11px] text-neutral-600">
          Микрофон → Supabase Storage → Deepgram nova-3 → DeepSeek → voice_notes
        </p>
      </div>
    </main>
  );
}

function Board({
  hasLoaded,
  groupedNotes,
  activeColumn,
  pendingIds,
  onToggleStatus,
}: {
  hasLoaded: boolean;
  groupedNotes: Record<Category, VoiceNote[]>;
  activeColumn: Category;
  pendingIds: string[];
  onToggleStatus: (note: VoiceNote) => Promise<void>;
}) {
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-4">
      {COLUMNS.map((column) => {
        const items = groupedNotes[column.id];

        return (
          <section
            key={column.id}
            aria-label={column.title}
            className={cn(
              "flex-col overflow-hidden rounded-2xl border border-white/5 bg-neutral-900/40",
              activeColumn === column.id ? "flex" : "hidden lg:flex",
            )}
          >
            <div
              className={cn("h-px w-full bg-gradient-to-r to-transparent", column.gradient)}
            />

            <header className="flex items-center gap-2 px-3.5 py-2.5">
              <span aria-hidden className="text-sm">
                {column.emoji}
              </span>
              <h2 className="truncate text-sm font-medium text-neutral-200">
                {column.title}
              </h2>
              <span className="ml-auto rounded-full bg-neutral-800/80 px-2 py-0.5 text-[11px] tabular-nums text-neutral-400">
                {items.length}
              </span>
            </header>

            <div className="flex flex-col gap-2.5 p-2.5 pt-0 lg:max-h-[calc(100dvh-15rem)] lg:overflow-y-auto lg:[scrollbar-width:thin]">
              {!hasLoaded ? (
                <>
                  <CardSkeleton />
                  <CardSkeleton />
                </>
              ) : items.length === 0 ? (
                <p className="rounded-xl border border-dashed border-white/5 px-3 py-8 text-center text-xs text-neutral-600">
                  Пока пусто
                </p>
              ) : (
                items.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    isPending={pendingIds.includes(note.id)}
                    onToggleStatus={onToggleStatus}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function NoteCard({
  note,
  isPending,
  onToggleStatus,
}: {
  note: VoiceNote;
  isPending: boolean;
  onToggleStatus: (note: VoiceNote) => Promise<void>;
}) {
  const isDone = note.status === "done";
  const text = noteText(note);
  const deadline =
    note.category === "task" && note.action_date ? formatDeadline(note.action_date) : null;

  return (
    <article
      className={cn(
        "rounded-xl border border-white/5 bg-neutral-900 p-3 shadow-sm shadow-black/40 transition hover:border-white/10 hover:bg-neutral-900/90",
        isDone && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <time
          dateTime={note.created_at ?? undefined}
          className="pt-1 text-[11px] text-neutral-500"
        >
          {formatNoteTime(note.created_at)}
        </time>

        <StatusToggle note={note} isPending={isPending} onToggle={onToggleStatus} />
      </div>

      <h3
        className={cn(
          "mt-1 text-sm font-semibold leading-snug text-neutral-100",
          isDone && "line-through decoration-neutral-500",
        )}
      >
        {noteTitle(note)}
      </h3>

      {text ? (
        <p className="mt-1 line-clamp-5 whitespace-pre-line text-[13px] leading-relaxed text-neutral-400">
          {text}
        </p>
      ) : null}

      {deadline ? (
        <p
          className={cn(
            "mt-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset",
            deadline.overdue
              ? "bg-red-500/10 text-red-300 ring-red-500/25"
              : "bg-sky-500/10 text-sky-300 ring-sky-500/25",
          )}
        >
          <ClockIcon className="h-3 w-3" />
          {deadline.overdue ? "Просрочено:" : "Дедлайн:"} {deadline.label}
        </p>
      ) : null}

      {note.category === "music" && note.audio_url ? (
        <audio
          controls
          preload="none"
          src={note.audio_url}
          className="mt-2.5 h-9 w-full [color-scheme:dark]"
        />
      ) : null}
    </article>
  );
}

function StatusToggle({
  note,
  isPending,
  onToggle,
}: {
  note: VoiceNote;
  isPending: boolean;
  onToggle: (note: VoiceNote) => Promise<void>;
}) {
  const isDone = note.status === "done";

  return (
    <button
      type="button"
      onClick={() => void onToggle(note)}
      disabled={isPending}
      aria-pressed={isDone}
      aria-label={isDone ? "Вернуть в работу" : "Отметить выполненным"}
      title={isDone ? "Вернуть в работу" : "Отметить выполненным"}
      className={cn(
        "ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-full border transition",
        isDone
          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
          : "border-white/10 bg-neutral-800/60 text-neutral-500 hover:border-emerald-500/40 hover:text-emerald-300",
        isPending && "opacity-50",
      )}
    >
      {isPending ? <Spinner className="h-3.5 w-3.5" /> : <CheckIcon className="h-4 w-4" />}
    </button>
  );
}

function RecordButton({
  phase,
  seconds,
  onClick,
}: {
  phase: Phase;
  seconds: number;
  onClick: () => void;
}) {
  const isRecording = phase === "recording";
  const isProcessing = phase === "requesting" || phase === "processing";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isProcessing}
      aria-label={isRecording ? "Остановить запись" : "Записать голосовую заметку"}
      className={cn(
        "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border px-3 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed",
        isRecording
          ? "border-red-500/40 bg-red-500/15 text-red-200 focus-visible:outline-red-400"
          : "border-white/10 bg-neutral-900 text-neutral-200 hover:border-white/20 hover:bg-neutral-800 focus-visible:outline-indigo-400",
        isProcessing && "opacity-70",
      )}
    >
      {isRecording ? (
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
        </span>
      ) : isProcessing ? (
        <Spinner className="h-4 w-4" />
      ) : (
        <MicIcon className="h-4 w-4" />
      )}

      <span className="font-mono text-[13px] tabular-nums">
        {isRecording ? formatDuration(seconds) : isProcessing ? "Обработка…" : "Записать"}
      </span>

      {isRecording ? (
        <span className="hidden text-[11px] font-normal text-red-300/80 sm:inline">Стоп</span>
      ) : null}
    </button>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? "h-4 w-4"}
    >
      <path d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? "h-4 w-4"}
    >
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? "h-4 w-4"}
    >
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? "h-4 w-4"}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-200",
        className ?? "h-4 w-4",
      )}
    />
  );
}

function CardSkeleton() {
  return (
    <div className="animate-pulse rounded-xl border border-white/5 bg-neutral-900 p-3">
      <div className="h-2.5 w-20 rounded bg-neutral-800" />
      <div className="mt-2 h-3.5 w-3/4 rounded bg-neutral-800" />
      <div className="mt-2 h-2.5 w-full rounded bg-neutral-800/70" />
      <div className="mt-1.5 h-2.5 w-2/3 rounded bg-neutral-800/70" />
    </div>
  );
}
