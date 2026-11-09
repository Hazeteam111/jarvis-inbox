"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Дашборд «Jarvis Inbox» в эстетике Apple (iOS HIG): матовые панели, плавные
 * скругления, динамические колонки по категориям, чипы подкатегорий и корзина.
 *
 * Все операции идут через API (`/api/voice-notes`), где используется
 * service_role-клиент, поэтому RLS-политики таблицы не мешают интерфейсу.
 */

type Phase = "idle" | "requesting" | "recording" | "processing" | "done" | "error";

type NoteStatus = "inbox" | "done";

type StatusFilter = "all" | "inbox" | "done";

type ViewMode = "board" | "trash";

type VoiceNote = {
  id: string;
  audio_url: string | null;
  raw_transcript: string | null;
  title: string | null;
  category: string | null;
  subcategory: string | null;
  cleaned_text: string | null;
  action_date: string | null;
  status: string | null;
  created_at: string | null;
  deleted_at: string | null;
};

type NotesResponse =
  | { status: "ok"; data: { active: VoiceNote[]; trash: VoiceNote[] } }
  | { status: "error"; error: string };

type VoiceInboxResponse =
  | { status: "ok"; data: VoiceNote }
  | { status: "error"; error: string };

type MutationResponse =
  | { status: "ok"; data: { id: string } }
  | { status: "error"; error: string };

type CategoryStyle = {
  title: string;
  emoji: string;
  chip: string;
  text: string;
  bar: string;
};

type ColumnData = {
  key: string;
  style: CategoryStyle;
  notes: VoiceNote[];
  visibleNotes: VoiceNote[];
  subcategories: Array<{ key: string; label: string; count: number }>;
};

const VOICE_INBOX_ENDPOINT = "/api/voice-inbox";
const VOICE_NOTES_ENDPOINT = "/api/voice-notes";
const AUDIO_FIELD = "audio";
const AUDIO_FILE_NAME = "record.m4a";

/** Значение «все подкатегории» в чипах колонки. */
const ALL_SUBCATEGORIES = "__all";

/** Ключ раздела для заметок, у которых категория не определена. */
const UNCATEGORIZED_KEY = "без раздела";

/** Порядок известных разделов; новые разделы идут после них по алфавиту. */
const CATEGORY_ORDER = ["music", "business", "task", "thought"];

/** Оформление известных разделов; незнакомые получают нейтральный стиль. */
const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  music: {
    title: "Музыка",
    emoji: "🎵",
    chip: "border-violet-400/30 bg-violet-500/15 text-violet-200",
    text: "text-violet-300",
    bar: "from-violet-400/70",
  },
  business: {
    title: "Бизнес",
    emoji: "💼",
    chip: "border-amber-400/30 bg-amber-500/15 text-amber-200",
    text: "text-amber-300",
    bar: "from-amber-400/70",
  },
  task: {
    title: "Задачи",
    emoji: "⏱",
    chip: "border-sky-400/30 bg-sky-500/15 text-sky-200",
    text: "text-sky-300",
    bar: "from-sky-400/70",
  },
  thought: {
    title: "Мысли",
    emoji: "💡",
    chip: "border-emerald-400/30 bg-emerald-500/15 text-emerald-200",
    text: "text-emerald-300",
    bar: "from-emerald-400/70",
  },
};

const FALLBACK_CATEGORY_STYLE: CategoryStyle = {
  title: "Раздел",
  emoji: "🗂",
  chip: "border-zinc-500/30 bg-zinc-500/15 text-zinc-200",
  text: "text-zinc-300",
  bar: "from-zinc-400/70",
};

/** Стили сегментированного переключателя «Канбан / Корзина». */
const SEGMENT_BASE = "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition";
const SEGMENT_ACTIVE = "bg-zinc-100 text-zinc-900 shadow-sm shadow-black/30";
const SEGMENT_IDLE = "text-zinc-400 hover:text-zinc-200";

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

/** Ключ раздела для группировки: нижний регистр, без лишних пробелов. */
function categoryKey(note: VoiceNote): string {
  const raw = (note.category ?? "").replace(/\s+/g, " ").trim().toLowerCase();

  return raw || UNCATEGORIZED_KEY;
}

/** Стиль колонки: известные разделы — из палитры, новые — нейтральные. */
function categoryStyle(key: string): CategoryStyle {
  const known = CATEGORY_STYLES[key];

  if (known) {
    return known;
  }

  return {
    ...FALLBACK_CATEGORY_STYLE,
    title: key === UNCATEGORIZED_KEY ? "Без раздела" : key.charAt(0).toUpperCase() + key.slice(1),
  };
}

/** Подкатегория как тег: нижний регистр, один пробел между словами. */
function subcategoryKey(note: VoiceNote): string {
  return (note.subcategory ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function subcategoryLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Порядок «свежие сверху» для оптимистичных вставок. */
function byCreatedDesc(a: VoiceNote, b: VoiceNote): number {
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
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

/** Человекочитаемое сообщение для неудачных запросов к API. */
function describeRequestError(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return "Нет связи с сервером. Проверьте, что приложение запущено, и повторите.";
  }

  return `Не удалось ${action}: ${message}`;
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
  const [activeNotes, setActiveNotes] = useState<VoiceNote[]>([]);
  const [trashNotes, setTrashNotes] = useState<VoiceNote[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("board");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [activeColumn, setActiveColumn] = useState<string | null>(null);
  const [subFilters, setSubFilters] = useState<Record<string, string>>({});
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

  /** Активные заметки и корзину отдаёт сервер (service_role обходит RLS). */
  const loadNotes = useCallback(async () => {
    setIsRefreshing(true);

    try {
      const response = await fetch(`${VOICE_NOTES_ENDPOINT}?scope=all`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as NotesResponse | null;

      if (!response.ok || !payload || payload.status !== "ok") {
        throw new Error(
          payload?.status === "error" ? payload.error : `Сервер ответил HTTP ${response.status}.`,
        );
      }

      setActiveNotes(payload.data.active);
      setTrashNotes(payload.data.trash);
      setLoadError(null);
      setLastLoadedAt(
        new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
      );
    } catch (error) {
      setLoadError(describeRequestError("загрузить заметки", error));
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

  /** PATCH заметки: смена статуса или перенос в корзину / из корзины. */
  async function patchNote(id: string, patch: { status?: NoteStatus; deleted?: boolean }) {
    const response = await fetch(`${VOICE_NOTES_ENDPOINT}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const payload = (await response.json().catch(() => null)) as MutationResponse | null;

    if (!response.ok || !payload || payload.status !== "ok") {
      throw new Error(
        payload?.status === "error" ? payload.error : `Сервер ответил HTTP ${response.status}.`,
      );
    }
  }

  /** Переключение статуса карточки inbox ⇄ done (оптимистично, с откатом). */
  async function toggleStatus(note: VoiceNote) {
    const nextStatus: NoteStatus = note.status === "done" ? "inbox" : "done";

    setActionError(null);
    setActiveNotes((prev) =>
      prev.map((item) => (item.id === note.id ? { ...item, status: nextStatus } : item)),
    );
    setPendingIds((prev) => [...prev, note.id]);

    try {
      await patchNote(note.id, { status: nextStatus });
    } catch (error) {
      setActiveNotes((prev) =>
        prev.map((item) => (item.id === note.id ? { ...item, status: note.status } : item)),
      );
      setActionError(describeRequestError("обновить статус", error));
    } finally {
      setPendingIds((prev) => prev.filter((id) => id !== note.id));
    }
  }

  /** Мягкое удаление: `deleted_at` выставляет сервер, карточка уезжает в корзину. */
  async function moveToTrash(note: VoiceNote) {
    const deletedAt = new Date().toISOString();

    setActionError(null);
    setActiveNotes((prev) => prev.filter((item) => item.id !== note.id));
    setTrashNotes((prev) => [{ ...note, deleted_at: deletedAt }, ...prev]);
    setPendingIds((prev) => [...prev, note.id]);

    try {
      await patchNote(note.id, { deleted: true });
    } catch (error) {
      setTrashNotes((prev) => prev.filter((item) => item.id !== note.id));
      setActiveNotes((prev) => [note, ...prev].sort(byCreatedDesc));
      setActionError(describeRequestError("убрать заметку в корзину", error));
    } finally {
      setPendingIds((prev) => prev.filter((id) => id !== note.id));
    }
  }

  /** Восстановление из корзины: `deleted_at = null`. */
  async function restoreNote(note: VoiceNote) {
    setActionError(null);
    setTrashNotes((prev) => prev.filter((item) => item.id !== note.id));
    setActiveNotes((prev) => [{ ...note, deleted_at: null }, ...prev].sort(byCreatedDesc));
    setPendingIds((prev) => [...prev, note.id]);

    try {
      await patchNote(note.id, { deleted: false });
    } catch (error) {
      setActiveNotes((prev) => prev.filter((item) => item.id !== note.id));
      setTrashNotes((prev) => [note, ...prev].sort(byCreatedDesc));
      setActionError(describeRequestError("восстановить заметку", error));
    } finally {
      setPendingIds((prev) => prev.filter((id) => id !== note.id));
    }
  }

  /** Физическое удаление: сервер чистит Storage и строку таблицы. */
  async function purgeNote(note: VoiceNote) {
    const confirmed = window.confirm(
      "Удалить заметку и её аудиозапись навсегда? Восстановить будет нельзя.",
    );

    if (!confirmed) {
      return;
    }

    setActionError(null);
    setPendingIds((prev) => [...prev, note.id]);

    try {
      const response = await fetch(`${VOICE_NOTES_ENDPOINT}/${note.id}`, { method: "DELETE" });
      const payload = (await response.json().catch(() => null)) as MutationResponse | null;

      if (!response.ok || !payload || payload.status !== "ok") {
        throw new Error(
          payload?.status === "error" ? payload.error : `Сервер ответил HTTP ${response.status}.`,
        );
      }

      setTrashNotes((prev) => prev.filter((item) => item.id !== note.id));
    } catch (error) {
      setActionError(describeRequestError("удалить заметку навсегда", error));
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

      setActiveNotes((prev) => [created, ...prev.filter((item) => item.id !== created.id)]);
      setTrashNotes((prev) => prev.filter((item) => item.id !== created.id));
      setStatusFilter("all");
      setView("board");
      setActiveColumn(categoryKey(created));
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

  const inboxCount = activeNotes.filter((note) => note.status !== "done").length;
  const filterCounts: Record<StatusFilter, number> = {
    all: activeNotes.length,
    inbox: inboxCount,
    done: activeNotes.length - inboxCount,
  };

  const statusFilteredNotes = useMemo(
    () =>
      activeNotes.filter((note) =>
        statusFilter === "all"
          ? true
          : statusFilter === "done"
            ? note.status === "done"
            : note.status !== "done",
      ),
    [activeNotes, statusFilter],
  );

  /** Колонки строятся по фактическим категориям активных заметок. */
  const columns = useMemo<ColumnData[]>(() => {
    const buckets = new Map<string, VoiceNote[]>();

    for (const note of statusFilteredNotes) {
      const key = categoryKey(note);
      const bucket = buckets.get(key);

      if (bucket) {
        bucket.push(note);
      } else {
        buckets.set(key, [note]);
      }
    }

    const rank = (key: string) => {
      const index = CATEGORY_ORDER.indexOf(key);

      return index === -1 ? CATEGORY_ORDER.length : index;
    };

    return [...buckets.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], "ru"))
      .map(([key, notes]) => {
        const counts = new Map<string, number>();

        for (const note of notes) {
          const sub = subcategoryKey(note);

          if (sub) {
            counts.set(sub, (counts.get(sub) ?? 0) + 1);
          }
        }

        const subcategories = [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
          .map(([subKey, count]) => ({
            key: subKey,
            label: subcategoryLabel(subKey),
            count,
          }));

        const selected = subFilters[key] ?? ALL_SUBCATEGORIES;

        return {
          key,
          style: categoryStyle(key),
          notes,
          subcategories,
          visibleNotes:
            selected === ALL_SUBCATEGORIES
              ? notes
              : notes.filter((note) => subcategoryKey(note) === selected),
        } satisfies ColumnData;
      });
  }, [statusFilteredNotes, subFilters]);

  const activeColumnKey =
    columns.find((column) => column.key === activeColumn)?.key ?? columns[0]?.key ?? null;

  const statusLine = PHASE_TEXT[phase];

  return (
    <main className="relative flex min-h-dvh flex-1 flex-col bg-zinc-950 text-zinc-100 antialiased">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(110,120,255,0.18),transparent_72%)]"
      />

      <header className="sticky top-0 z-30 border-b border-zinc-800/50 bg-zinc-950/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1700px] items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-6">
          <div className="mr-auto flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden
              className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl border border-zinc-700/60 bg-gradient-to-br from-zinc-700/50 to-zinc-900 text-base shadow-lg shadow-black/30"
            >
              🤖
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold tracking-tight sm:text-base">
                Jarvis Inbox
              </h1>
              <p className="hidden truncate text-[11px] text-zinc-500 sm:block">
                Голос → Deepgram nova-3 → DeepSeek → канбан
              </p>
            </div>
          </div>

          <nav
            aria-label="Разделы приложения"
            className="flex shrink-0 items-center gap-1 rounded-full border border-zinc-800/60 bg-zinc-900/60 p-1 backdrop-blur-xl"
          >
            <button
              type="button"
              onClick={() => setView("board")}
              aria-pressed={view === "board"}
              className={cn(SEGMENT_BASE, view === "board" ? SEGMENT_ACTIVE : SEGMENT_IDLE)}
            >
              <GridIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Канбан</span>
            </button>
            <button
              type="button"
              onClick={() => setView("trash")}
              aria-pressed={view === "trash"}
              className={cn(SEGMENT_BASE, view === "trash" ? SEGMENT_ACTIVE : SEGMENT_IDLE)}
            >
              <TrashIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Корзина</span>
              {trashNotes.length > 0 ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] tabular-nums",
                    view === "trash" ? "bg-zinc-900/15 text-zinc-700" : "bg-zinc-800 text-zinc-300",
                  )}
                >
                  {trashNotes.length}
                </span>
              ) : null}
            </button>
          </nav>

          <RecordButton phase={phase} seconds={seconds} onClick={handleRecordClick} />

          <button
            type="button"
            onClick={() => void loadNotes()}
            disabled={isRefreshing}
            title="Обновить список заметок"
            aria-label="Обновить список заметок"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-zinc-800/60 bg-zinc-900/60 text-zinc-300 backdrop-blur-xl transition hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-60"
          >
            <RefreshIcon className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
          </button>
        </div>

        {statusLine ? (
          <div className="mx-auto flex w-full max-w-[1700px] items-center gap-2 px-3 pb-2.5 text-[11px] text-zinc-500 sm:px-6 sm:text-xs">
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
            className="mt-3 flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-red-200 backdrop-blur-xl"
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
            className="mt-3 flex flex-col gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-amber-200 backdrop-blur-xl sm:flex-row sm:items-center"
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
          <div className="flex rounded-full border border-zinc-800/60 bg-zinc-900/60 p-1 backdrop-blur-xl">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setStatusFilter(filter.id)}
                aria-pressed={statusFilter === filter.id}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs font-medium transition",
                  statusFilter === filter.id
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-500 hover:text-zinc-200",
                )}
              >
                {filter.label}
                <span
                  className={cn(
                    "ml-1.5 tabular-nums",
                    statusFilter === filter.id ? "text-zinc-500" : "text-zinc-600",
                  )}
                >
                  {filterCounts[filter.id]}
                </span>
              </button>
            ))}
          </div>

          <p className="ml-auto hidden text-[11px] text-zinc-600 sm:block">
            {lastLoadedAt ? `обновлено ${lastLoadedAt}` : null}
          </p>
        </div>

        {view === "board" ? (
          <>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] lg:hidden [&::-webkit-scrollbar]:hidden">
              {columns.map((column) => {
                const isActive = activeColumnKey === column.key;

                return (
                  <button
                    key={column.key}
                    type="button"
                    onClick={() => setActiveColumn(column.key)}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                      isActive
                        ? column.style.chip
                        : "border-zinc-800/60 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200",
                    )}
                  >
                    <span aria-hidden>{column.style.emoji}</span>
                    {column.style.title}
                    <span className="tabular-nums opacity-70">{column.notes.length}</span>
                  </button>
                );
              })}
            </div>

            <Board
              columns={columns}
              hasLoaded={hasLoaded}
              activeColumnKey={activeColumnKey}
              subFilters={subFilters}
              pendingIds={pendingIds}
              onSelectSubcategory={(columnKey, subcategory) =>
                setSubFilters((prev) => ({ ...prev, [columnKey]: subcategory }))
              }
              onToggleStatus={toggleStatus}
              onTrash={moveToTrash}
            />
          </>
        ) : (
          <TrashList
            notes={trashNotes}
            hasLoaded={hasLoaded}
            pendingIds={pendingIds}
            onRestore={restoreNote}
            onPurge={purgeNote}
          />
        )}

        {actionError ? (
          <div
            role="alert"
            className="mt-4 flex items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200 backdrop-blur-xl"
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

        <p className="mt-8 text-center text-[11px] text-zinc-600">
          Микрофон → Supabase Storage → Deepgram nova-3 → DeepSeek → voice_notes
        </p>
      </div>
    </main>
  );
}

function Board({
  columns,
  hasLoaded,
  activeColumnKey,
  subFilters,
  pendingIds,
  onSelectSubcategory,
  onToggleStatus,
  onTrash,
}: {
  columns: ColumnData[];
  hasLoaded: boolean;
  activeColumnKey: string | null;
  subFilters: Record<string, string>;
  pendingIds: string[];
  onSelectSubcategory: (columnKey: string, subcategory: string) => void;
  onToggleStatus: (note: VoiceNote) => Promise<void>;
  onTrash: (note: VoiceNote) => Promise<void>;
}) {
  if (!hasLoaded) {
    return (
      <div className="mt-4 grid grid-cols-1 gap-3.5 lg:grid-cols-[repeat(auto-fit,minmax(19rem,1fr))]">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="flex flex-col gap-2.5 rounded-2xl border border-zinc-800/50 bg-zinc-900/40 p-3 backdrop-blur-xl"
          >
            <div className="h-3 w-24 animate-pulse rounded-full bg-zinc-800" />
            <CardSkeleton />
            <CardSkeleton />
          </div>
        ))}
      </div>
    );
  }

  if (columns.length === 0) {
    return (
      <div className="mt-4 rounded-3xl border border-dashed border-zinc-800/70 bg-zinc-900/40 px-6 py-16 text-center backdrop-blur-xl">
        <p aria-hidden className="text-3xl">
          🎙
        </p>
        <p className="mt-3 text-sm font-medium text-zinc-300">Пока пусто</p>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-zinc-500">
          Нажмите «Записать» в шапке — заметка сама разложится по разделам и подкатегориям.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 grid grid-cols-1 gap-3.5 lg:grid-cols-[repeat(auto-fit,minmax(19rem,1fr))]">
      {columns.map((column) => {
        const selected = subFilters[column.key] ?? ALL_SUBCATEGORIES;

        return (
          <section
            key={column.key}
            aria-label={column.style.title}
            className={cn(
              "flex-col overflow-hidden rounded-2xl border border-zinc-800/50 bg-zinc-900/40 backdrop-blur-xl",
              activeColumnKey === column.key ? "flex" : "hidden lg:flex",
            )}
          >
            <div className={cn("h-px w-full bg-gradient-to-r to-transparent", column.style.bar)} />

            <header className="flex items-center gap-2 px-4 pt-3">
              <span aria-hidden className="text-sm">
                {column.style.emoji}
              </span>
              <h2 className="truncate text-sm font-semibold text-zinc-200">{column.style.title}</h2>
              <span className="ml-auto rounded-full bg-zinc-800/70 px-2 py-0.5 text-[11px] tabular-nums text-zinc-400">
                {column.notes.length}
              </span>
            </header>

            {column.subcategories.length > 0 ? (
              <div className="mt-2.5 flex flex-wrap gap-1.5 px-4">
                <SubChip
                  active={selected === ALL_SUBCATEGORIES}
                  onClick={() => onSelectSubcategory(column.key, ALL_SUBCATEGORIES)}
                >
                  Все
                </SubChip>
                {column.subcategories.map((sub) => (
                  <SubChip
                    key={sub.key}
                    active={selected === sub.key}
                    onClick={() => onSelectSubcategory(column.key, sub.key)}
                  >
                    {sub.label}
                    <span className="ml-1 tabular-nums opacity-60">{sub.count}</span>
                  </SubChip>
                ))}
              </div>
            ) : null}

            <div className="flex flex-col gap-2.5 p-3 lg:max-h-[calc(100dvh-17rem)] lg:overflow-y-auto lg:[scrollbar-width:thin]">
              {column.visibleNotes.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-zinc-800/60 px-3 py-8 text-center text-xs text-zinc-600">
                  {column.notes.length === 0 ? "Пока пусто" : "В этой подкатегории пусто"}
                </p>
              ) : (
                column.visibleNotes.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    isPending={pendingIds.includes(note.id)}
                    onToggleStatus={onToggleStatus}
                    onTrash={onTrash}
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
  onTrash,
}: {
  note: VoiceNote;
  isPending: boolean;
  onToggleStatus: (note: VoiceNote) => Promise<void>;
  onTrash: (note: VoiceNote) => Promise<void>;
}) {
  const isDone = note.status === "done";
  const text = noteText(note);
  const subcategory = subcategoryKey(note);
  const deadline =
    categoryKey(note) === "task" && note.action_date ? formatDeadline(note.action_date) : null;

  return (
    <article
      className={cn(
        "rounded-2xl border border-zinc-800/60 bg-zinc-900/60 p-3.5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04),0_14px_30px_-24px_rgba(0,0,0,0.95)] backdrop-blur-xl transition hover:border-zinc-700/70 hover:bg-zinc-900/80",
        isDone && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <time dateTime={note.created_at ?? undefined} className="truncate text-[11px] text-zinc-500">
          {formatNoteTime(note.created_at)}
        </time>

        {subcategory ? (
          <span className="max-w-[9rem] truncate rounded-full border border-zinc-700/50 bg-zinc-800/60 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
            {subcategoryLabel(subcategory)}
          </span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <StatusToggle note={note} isPending={isPending} onToggle={onToggleStatus} />
          <button
            type="button"
            onClick={() => void onTrash(note)}
            disabled={isPending}
            aria-label="Убрать в корзину"
            title="Убрать в корзину"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-zinc-800/70 bg-zinc-900/70 text-zinc-500 transition hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <h3
        className={cn(
          "mt-2 text-sm font-semibold leading-snug text-zinc-100",
          isDone && "line-through decoration-zinc-500",
        )}
      >
        {noteTitle(note)}
      </h3>

      {text ? (
        <p className="mt-1 line-clamp-5 whitespace-pre-line text-[13px] leading-relaxed text-zinc-400">
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

      {note.audio_url ? <AudioPlayer src={note.audio_url} /> : null}
    </article>
  );
}

function SubChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
        active
          ? "border-zinc-500/60 bg-zinc-100 text-zinc-900"
          : "border-zinc-800/70 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
      )}
    >
      {children}
    </button>
  );
}

/** Компактный плеер: play/pause, тонкая полоса прогресса, без нативного UI. */
function AudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  function togglePlayback() {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    if (audio.paused) {
      void audio.play().catch(() => setIsPlaying(false));

      return;
    }

    audio.pause();
  }

  return (
    <div className="mt-3 flex items-center gap-2.5 rounded-full border border-zinc-800/60 bg-zinc-950/50 py-1 pl-1 pr-3">
      <button
        type="button"
        onClick={togglePlayback}
        aria-label={isPlaying ? "Пауза" : "Прослушать запись"}
        title={isPlaying ? "Пауза" : "Прослушать запись"}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-900 transition hover:bg-white"
      >
        {isPlaying ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
      </button>

      <span className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
        <span
          className="block h-full rounded-full bg-zinc-400 transition-[width] duration-200"
          style={{ width: `${progress}%` }}
        />
      </span>

      <audio
        ref={audioRef}
        src={src}
        preload="none"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setProgress(0);
        }}
        onTimeUpdate={(event) => {
          const element = event.currentTarget;

          setProgress(element.duration ? (element.currentTime / element.duration) * 100 : 0);
        }}
        className="hidden"
      />
    </div>
  );
}

/** Корзина: восстановление и окончательное удаление (с чисткой Storage на сервере). */
function TrashList({
  notes,
  hasLoaded,
  pendingIds,
  onRestore,
  onPurge,
}: {
  notes: VoiceNote[];
  hasLoaded: boolean;
  pendingIds: string[];
  onRestore: (note: VoiceNote) => Promise<void>;
  onPurge: (note: VoiceNote) => Promise<void>;
}) {
  if (!hasLoaded) {
    return (
      <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  if (notes.length === 0) {
    return (
      <div className="mt-4 rounded-3xl border border-dashed border-zinc-800/70 bg-zinc-900/40 px-6 py-16 text-center backdrop-blur-xl">
        <p aria-hidden className="text-3xl">
          🗑
        </p>
        <p className="mt-3 text-sm font-medium text-zinc-300">Корзина пуста</p>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-zinc-500">
          Удалённые заметки появятся здесь — их можно восстановить или стереть навсегда.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
      {notes.map((note) => {
        const isPending = pendingIds.includes(note.id);
        const style = categoryStyle(categoryKey(note));

        return (
          <article
            key={note.id}
            className="flex flex-col rounded-2xl border border-zinc-800/60 bg-zinc-900/60 p-4 backdrop-blur-xl transition hover:border-zinc-700/70"
          >
            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
              <span aria-hidden>{style.emoji}</span>
              <span className="truncate">{style.title}</span>
              <span className="ml-auto shrink-0 text-zinc-600">
                удалено {formatNoteTime(note.deleted_at)}
              </span>
            </div>

            <h3 className="mt-2 text-sm font-semibold leading-snug text-zinc-200">
              {noteTitle(note)}
            </h3>

            <p className="mt-1 line-clamp-3 whitespace-pre-line text-[13px] leading-relaxed text-zinc-500">
              {noteText(note)}
            </p>

            <div className="mt-3.5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void onRestore(note)}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700/70 bg-zinc-800/70 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 disabled:opacity-50"
              >
                <RestoreIcon className="h-3.5 w-3.5" />
                Восстановить
              </button>
              <button
                type="button"
                onClick={() => void onPurge(note)}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:border-red-500/50 hover:bg-red-500/20 disabled:opacity-50"
              >
                <TrashIcon className="h-3.5 w-3.5" />
                Удалить навсегда
              </button>
            </div>
          </article>
        );
      })}
    </div>
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
        "grid h-7 w-7 shrink-0 place-items-center rounded-full border transition",
        isDone
          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
          : "border-zinc-800/70 bg-zinc-900/70 text-zinc-500 hover:border-emerald-500/40 hover:text-emerald-300",
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
        "inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-3 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed sm:px-4",
        isRecording
          ? "bg-red-500 text-white shadow-lg shadow-red-500/25 focus-visible:outline-red-300"
          : "bg-zinc-100 text-zinc-900 shadow-lg shadow-black/30 hover:bg-white focus-visible:outline-zinc-300",
        isProcessing && "opacity-70",
      )}
    >
      {isRecording ? (
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
        </span>
      ) : isProcessing ? (
        <Spinner className="h-4 w-4" tone="dark" />
      ) : (
        <MicIcon className="h-4 w-4" />
      )}

      <span
        className={cn(
          "font-mono text-[13px] tabular-nums",
          !isRecording && !isProcessing && "hidden sm:inline",
        )}
      >
        {isRecording ? formatDuration(seconds) : isProcessing ? "Обработка…" : "Записать"}
      </span>

      {isRecording ? (
        <span className="hidden text-[11px] font-normal text-white/80 sm:inline">Стоп</span>
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

function Spinner({
  className,
  tone = "light",
}: {
  className?: string;
  tone?: "light" | "dark";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block animate-spin rounded-full border-2",
        tone === "dark" ? "border-zinc-400/40 border-t-zinc-900" : "border-zinc-600 border-t-zinc-200",
        className ?? "h-4 w-4",
      )}
    />
  );
}

function CardSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border border-zinc-800/50 bg-zinc-900/60 p-3.5 backdrop-blur-xl">
      <div className="h-2.5 w-20 rounded-full bg-zinc-800" />
      <div className="mt-2.5 h-3.5 w-3/4 rounded-full bg-zinc-800" />
      <div className="mt-2.5 h-2.5 w-full rounded-full bg-zinc-800/70" />
      <div className="mt-1.5 h-2.5 w-2/3 rounded-full bg-zinc-800/70" />
    </div>
  );
}

function GridIcon({ className }: { className?: string }) {
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
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
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
      <path d="M4 7h16" />
      <path d="M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1Z" />
      <path d="M6 7l.8 12.1A2 2 0 0 0 8.8 21h6.4a2 2 0 0 0 2-1.9L18 7" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

function RestoreIcon({ className }: { className?: string }) {
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
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className ?? "h-4 w-4"}
    >
      <path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.8l-10-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className ?? "h-4 w-4"}
    >
      <rect x="7" y="5" width="3.5" height="14" rx="1.2" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1.2" />
    </svg>
  );
}
