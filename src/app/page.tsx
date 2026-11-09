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

type TelegramSettings = {
  bot_token: string;
  chat_id: string;
  is_active: boolean;
  summary_time: string;
  last_summary_date: string | null;
};

type TelegramSettingsForm = {
  bot_token: string;
  chat_id: string;
  is_active: boolean;
  summary_time: string;
};

type TelegramSettingsResponse =
  | { status: "ok"; data: TelegramSettings }
  | { status: "error"; error: string };

type DailySummaryResponse =
  | {
      status: "ok";
      data: {
        sent_at: string;
        date: string;
        summary_time: string;
        notes: number;
        forced: boolean;
      };
    }
  | { status: "skipped"; reason: string; detail?: string }
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
const TELEGRAM_SETTINGS_ENDPOINT = "/api/settings/telegram";
const DAILY_SUMMARY_ENDPOINT = "/api/cron/daily-summary";
const AUDIO_FIELD = "audio";
const AUDIO_FILE_NAME = "record.m4a";

/** Время вечернего отчёта по умолчанию — как в API и в таблице app_settings. */
const DEFAULT_SUMMARY_TIME = "21:30";

/** Расшифровка причин, по которым крон не отправил отчёт. */
const SUMMARY_SKIP_TEXT: Record<string, string> = {
  not_configured: "Не заданы токен бота или chat_id — отчёт некуда отправлять.",
  inactive: "Отправка ежедневного отчёта выключена тумблером.",
  not_scheduled_time: "Сейчас не время отчёта — автоматическая отправка пропущена.",
  already_sent_today: "Отчёт за сегодня уже отправлен.",
};

/** Значение «все подкатегории» в чипах колонки. */
const ALL_SUBCATEGORIES = "__all";

/** Ключ раздела для заметок, у которых категория не определена. */
const UNCATEGORIZED_KEY = "без раздела";

/** Порядок известных разделов; новые разделы идут после них по алфавиту. */
const CATEGORY_ORDER = ["music", "business", "task", "thought"];

/**
 * Оформление известных разделов; незнакомые получают нейтральный стиль.
 * Цвета — Apple System Colors из дизайн-системы: #BF5AF2, #FF9F0A, #0A84FF,
 * #30D158. Полупрозрачные заливки и кромки считаются от того же HEX.
 */
const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  music: {
    title: "Музыка",
    emoji: "🎵",
    chip: "border-[#bf5af2]/35 bg-[#bf5af2]/15 text-[#dcb0ff]",
    text: "text-[#dcb0ff]",
    bar: "from-[#bf5af2]/70",
  },
  business: {
    title: "Бизнес",
    emoji: "💼",
    chip: "border-[#ff9f0a]/35 bg-[#ff9f0a]/15 text-[#ffc46b]",
    text: "text-[#ffc46b]",
    bar: "from-[#ff9f0a]/70",
  },
  task: {
    title: "Задачи",
    emoji: "⏱",
    chip: "border-[#0a84ff]/35 bg-[#0a84ff]/15 text-[#6ab7ff]",
    text: "text-[#6ab7ff]",
    bar: "from-[#0a84ff]/70",
  },
  thought: {
    title: "Мысли",
    emoji: "💡",
    chip: "border-[#30d158]/40 bg-[#30d158]/15 text-[#7ee6a0]",
    text: "text-[#7ee6a0]",
    bar: "from-[#30d158]/70",
  },
};

const FALLBACK_CATEGORY_STYLE: CategoryStyle = {
  title: "Раздел",
  emoji: "🗂",
  chip: "border-stroke-2 bg-panel text-muted",
  text: "text-muted",
  bar: "from-white/40",
};

/** Стили сегментированного переключателя «Канбан / Корзина». */
const SEGMENT_BASE = "seg-btn";
const SEGMENT_ACTIVE = "seg-btn-on";
const SEGMENT_IDLE = "";

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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
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
    <main className="relative flex min-h-dvh flex-1 flex-col bg-bg font-sans text-ink antialiased">
      <div aria-hidden className="app-aurora">
        <span className="app-glow app-glow-1" />
        <span className="app-glow app-glow-2" />
        <span className="app-glow app-glow-3" />
      </div>

      <header className="glass sticky top-0 z-30 rounded-b-[24px] border-x-0 border-t-0">
        <div className="mx-auto flex w-full max-w-[1700px] items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-6">
          <div className="mr-auto flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden
              className="glass-lite grid h-9 w-9 shrink-0 place-items-center rounded-[15px] text-base"
            >
              🤖
            </span>
            <div className="min-w-0">
              <h1 className="truncate font-display text-[15px] font-semibold tracking-[0.06em] sm:text-base">
                Jarvis Inbox<span className="opacity-45">.</span>
              </h1>
              <p className="hidden truncate text-[10px] uppercase tracking-[0.14em] text-dim sm:block">
                Голос → Deepgram nova-3 → DeepSeek → канбан
              </p>
            </div>
          </div>

          <nav aria-label="Разделы приложения" className="seg shrink-0">
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
                    view === "trash" ? "bg-black/10 text-black/55" : "bg-white/10 text-ink/70",
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
            onClick={() => setIsSettingsOpen(true)}
            title="Настройки Telegram"
            aria-label="Настройки Telegram"
            className="icon-btn"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => void loadNotes()}
            disabled={isRefreshing}
            title="Обновить список заметок"
            aria-label="Обновить список заметок"
            className="icon-btn"
          >
            <RefreshIcon className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
          </button>
        </div>

        {statusLine ? (
          <div className="mx-auto flex w-full max-w-[1700px] items-center gap-2 px-3 pb-2.5 text-[11px] text-muted sm:px-6 sm:text-xs">
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
            className="glass-lite mt-3 flex items-start gap-3 rounded-[18px] border border-[#ff453a]/30 px-3.5 py-2.5 text-xs leading-relaxed text-[#ffb3ae]"
          >
            <span className="flex-1">{recordError}</span>
            <button
              type="button"
              onClick={() => {
                setRecordError(null);
                setPhase("idle");
              }}
              aria-label="Скрыть сообщение об ошибке"
              className="shrink-0 font-bold text-[#ff8f86] transition hover:text-white"
            >
              ✕
            </button>
          </div>
        ) : null}

        {loadError ? (
          <div
            role="alert"
            className="glass-lite mt-3 flex flex-col gap-2 rounded-[18px] border border-[#ffd60a]/30 px-3.5 py-2.5 text-xs leading-relaxed text-[#ffe27a] sm:flex-row sm:items-center"
          >
            <span className="flex-1">{loadError}</span>
            <button
              type="button"
              onClick={() => void loadNotes()}
              className="chip self-start border-[#ffd60a]/30 text-[#ffe27a] hover:text-white sm:self-auto"
            >
              Повторить
            </button>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="seg">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setStatusFilter(filter.id)}
                aria-pressed={statusFilter === filter.id}
                className={cn(
                  SEGMENT_BASE,
                  statusFilter === filter.id ? SEGMENT_ACTIVE : SEGMENT_IDLE,
                )}
              >
                {filter.label}
                <span
                  className={cn(
                    "tabular-nums",
                    statusFilter === filter.id ? "text-black/45" : "text-dim",
                  )}
                >
                  {filterCounts[filter.id]}
                </span>
              </button>
            ))}
          </div>

          <p className="ml-auto hidden text-[11px] text-dim sm:block">
            {lastLoadedAt ? `обновлено ${lastLoadedAt}` : null}
          </p>
        </div>

        {view === "board" ? (
          <>
            <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1 lg:hidden">
              {columns.map((column) => {
                const isActive = activeColumnKey === column.key;

                return (
                  <button
                    key={column.key}
                    type="button"
                    onClick={() => setActiveColumn(column.key)}
                    className={cn("chip shrink-0", isActive ? column.style.chip : "")}
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
            className="glass-lite mt-4 flex items-center gap-3 rounded-[18px] border border-[#ffd60a]/30 px-3.5 py-2.5 text-xs text-[#ffe27a]"
          >
            <span className="flex-1">{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="shrink-0 font-bold text-[#ffe27a]/80 transition hover:text-white"
            >
              Закрыть
            </button>
          </div>
        ) : null}

        {isSettingsOpen ? (
          <TelegramSettingsModal onClose={() => setIsSettingsOpen(false)} />
        ) : null}

        <p className="mt-8 text-center text-[10px] uppercase tracking-[0.14em] text-dim">
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
          <div key={index} className="surface flex flex-col gap-2.5 p-3">
            <div className="h-3 w-24 animate-pulse rounded-full bg-white/10" />
            <CardSkeleton />
            <CardSkeleton />
          </div>
        ))}
      </div>
    );
  }

  if (columns.length === 0) {
    return (
      <div className="surface mt-4 rounded-[28px] border-dashed px-6 py-16 text-center">
        <p aria-hidden className="text-3xl">
          🎙
        </p>
        <p className="mt-3 font-display text-sm font-semibold text-ink">Пока пусто</p>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted">
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
              "surface flex-col overflow-hidden rounded-card",
              activeColumnKey === column.key ? "flex" : "hidden lg:flex",
            )}
          >
            <div className={cn("h-px w-full bg-gradient-to-r to-transparent", column.style.bar)} />

            <header className="flex items-center gap-2 px-4 pt-3.5">
              <span aria-hidden className="text-sm">
                {column.style.emoji}
              </span>
              <h2 className="truncate font-display text-[13px] font-semibold tracking-wide text-ink">
                {column.style.title}
              </h2>
              <span className="ml-auto rounded-full border border-stroke bg-white/5 px-2 py-0.5 text-[11px] tabular-nums text-muted">
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

            <div className="no-scrollbar flex flex-col gap-2.5 p-3 lg:max-h-[calc(100dvh-17rem)] lg:overflow-y-auto">
              {column.visibleNotes.length === 0 ? (
                <p className="rounded-[18px] border border-dashed border-stroke px-3 py-8 text-center text-xs text-dim">
                  {column.notes.length === 0 ? "Пока пусто" : "В этой подкатегории пусто"}
                </p>
              ) : (
                column.visibleNotes.map((note, index) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    index={index}
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
  index,
  isPending,
  onToggleStatus,
  onTrash,
}: {
  note: VoiceNote;
  index: number;
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
      className={cn("surface surface-hover anim-rise p-3.5", isDone && "opacity-60")}
      style={{ animationDelay: `${index * 34}ms` }}
    >
      <div className="flex items-center gap-2">
        <time dateTime={note.created_at ?? undefined} className="truncate text-[11px] text-dim">
          {formatNoteTime(note.created_at)}
        </time>

        {subcategory ? (
          <span className="max-w-[9rem] truncate rounded-pill border border-stroke bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold text-muted">
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
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-stroke bg-white/5 text-dim transition hover:border-[#ff453a]/40 hover:text-[#ff8f86] disabled:opacity-50"
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <h3
        className={cn(
          "mt-2 font-display text-[13.5px] font-semibold leading-snug tracking-tight text-ink",
          isDone && "line-through decoration-white/35",
        )}
      >
        {noteTitle(note)}
      </h3>

      {text ? (
        <p className="mt-1.5 line-clamp-5 whitespace-pre-line text-[13px] leading-relaxed text-muted">
          {text}
        </p>
      ) : null}

      {deadline ? (
        <p
          className={cn(
            "mt-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
            deadline.overdue
              ? "bg-[#ff453a]/12 text-[#ff8f86] ring-[#ff453a]/30"
              : "bg-[#0a84ff]/12 text-[#6ab7ff] ring-[#0a84ff]/30",
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
      className={cn("chip px-2.5 py-1 text-[11px]", active ? "chip-on" : "")}
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
    <div className="mt-3 flex items-center gap-2.5 rounded-pill border border-stroke bg-white/[0.04] py-1 pl-1 pr-3">
      <button
        type="button"
        onClick={togglePlayback}
        aria-label={isPlaying ? "Пауза" : "Прослушать запись"}
        title={isPlaying ? "Пауза" : "Прослушать запись"}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white text-[#050507] shadow-[0_4px_14px_rgba(255,255,255,0.22)] transition active:scale-90"
      >
        {isPlaying ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
      </button>

      <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
        <span
          className="block h-full rounded-full bg-white/75 transition-[width] duration-200"
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
      <div className="surface mt-4 rounded-[28px] border-dashed px-6 py-16 text-center">
        <p aria-hidden className="text-3xl">
          🗑
        </p>
        <p className="mt-3 font-display text-sm font-semibold text-ink">Корзина пуста</p>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted">
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
          <article key={note.id} className="surface surface-hover flex flex-col p-4">
            <div className="flex items-center gap-2 text-[11px] text-dim">
              <span aria-hidden>{style.emoji}</span>
              <span className="truncate">{style.title}</span>
              <span className="ml-auto shrink-0 text-dim">
                удалено {formatNoteTime(note.deleted_at)}
              </span>
            </div>

            <h3 className="mt-2 font-display text-[13.5px] font-semibold leading-snug tracking-tight text-ink">
              {noteTitle(note)}
            </h3>

            <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-[13px] leading-relaxed text-muted">
              {noteText(note)}
            </p>

            <div className="mt-3.5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void onRestore(note)}
                disabled={isPending}
                className="btn btn-sm"
              >
                <RestoreIcon className="h-3.5 w-3.5" />
                Восстановить
              </button>
              <button
                type="button"
                onClick={() => void onPurge(note)}
                disabled={isPending}
                className="btn btn-sm btn-danger"
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
          ? "border-[#30d158]/45 bg-[#30d158]/15 text-[#30d158] hover:bg-[#30d158]/25"
          : "border-stroke bg-white/5 text-dim hover:border-[#30d158]/45 hover:text-[#30d158]",
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
        "inline-flex h-10 shrink-0 items-center gap-2 rounded-pill px-3 text-sm font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed sm:px-4",
        isRecording
          ? "anim-breathe bg-[#ff453a] text-white shadow-[0_10px_34px_rgba(255,69,58,0.38)] focus-visible:outline-[#ff8f86]"
          : "bg-white text-[#050507] shadow-[0_8px_28px_rgba(255,255,255,0.16)] hover:shadow-[0_12px_38px_rgba(255,255,255,0.3)] focus-visible:outline-white/60",
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
        tone === "dark" ? "border-black/25 border-t-[#050507]" : "border-white/20 border-t-white/80",
        className ?? "h-4 w-4",
      )}
    />
  );
}

function CardSkeleton() {
  return (
    <div className="surface animate-pulse rounded-[18px] p-3.5">
      <div className="h-2.5 w-20 rounded-full bg-white/10" />
      <div className="mt-2.5 h-3.5 w-3/4 rounded-full bg-white/10" />
      <div className="mt-2.5 h-2.5 w-full rounded-full bg-white/[0.07]" />
      <div className="mt-1.5 h-2.5 w-2/3 rounded-full bg-white/[0.07]" />
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

/** «2026-11-09» → «9 ноября»; подпись последней отправки в настройках. */
function formatSummaryDate(value: string | null): string {
  if (!value) {
    return "";
  }

  const date = new Date(`${value}T12:00:00+03:00`);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

/**
 * Модалка настроек Telegram в стиле iOS: токен бота, chat_id, тумблер ежедневной
 * отправки и время вечернего отчёта по Москве. «Отправить сейчас» сначала
 * сохраняет форму, затем дергает крон с `?force=true`.
 */
function TelegramSettingsModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<TelegramSettingsForm>({
    bot_token: "",
    chat_id: "",
    is_active: false,
    summary_time: DEFAULT_SUMMARY_TIME,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastSentDate, setLastSentDate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(TELEGRAM_SETTINGS_ENDPOINT, { cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as TelegramSettingsResponse | null;

        if (!response.ok || !payload || payload.status !== "ok") {
          throw new Error(
            payload?.status === "error" ? payload.error : `Сервер ответил HTTP ${response.status}.`,
          );
        }

        if (cancelled) {
          return;
        }

        setForm({
          bot_token: payload.data.bot_token,
          chat_id: payload.data.chat_id,
          is_active: payload.data.is_active,
          summary_time: payload.data.summary_time || DEFAULT_SUMMARY_TIME,
        });
        setLastSentDate(payload.data.last_summary_date);
      } catch (loadError) {
        if (!cancelled) {
          setError(describeRequestError("загрузить настройки Telegram", loadError));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    const previousOverflow = document.body.style.overflow;

    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  function updateField<K extends keyof TelegramSettingsForm>(
    key: K,
    value: TelegramSettingsForm[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function saveSettings(): Promise<TelegramSettings | null> {
    if (form.is_active && (!form.bot_token.trim() || !form.chat_id.trim())) {
      setError("Чтобы включить отправку, заполните токен бота и chat_id.");
      return null;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(TELEGRAM_SETTINGS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = (await response.json().catch(() => null)) as TelegramSettingsResponse | null;

      if (!response.ok || !payload || payload.status !== "ok") {
        throw new Error(
          payload?.status === "error" ? payload.error : `Сервер ответил HTTP ${response.status}.`,
        );
      }

      setForm({
        bot_token: payload.data.bot_token,
        chat_id: payload.data.chat_id,
        is_active: payload.data.is_active,
        summary_time: payload.data.summary_time,
      });
      setLastSentDate(payload.data.last_summary_date);

      return payload.data;
    } catch (saveError) {
      setError(describeRequestError("сохранить настройки", saveError));
      return null;
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSave() {
    const saved = await saveSettings();

    if (saved) {
      setNotice("Настройки сохранены.");
    }
  }

  async function sendNow() {
    if (!form.bot_token.trim() || !form.chat_id.trim()) {
      setError("Заполните токен бота и chat_id — без них отчёт некуда отправлять.");
      return;
    }

    setIsSending(true);
    setError(null);
    setNotice(null);

    try {
      const saved = await saveSettings();

      if (!saved) {
        return;
      }

      const response = await fetch(`${DAILY_SUMMARY_ENDPOINT}?force=true`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as DailySummaryResponse | null;

      if (!response.ok || !payload || payload.status === "error") {
        throw new Error(
          payload?.status === "error" ? payload.error : `Сервер ответил HTTP ${response.status}.`,
        );
      }

      if (payload.status === "skipped") {
        setError(payload.detail ?? SUMMARY_SKIP_TEXT[payload.reason] ?? "Отправка пропущена.");
        return;
      }

      setNotice(`Отчёт отправлен: ${payload.data.notes} заметок за ${payload.data.date}.`);
    } catch (sendError) {
      setError(describeRequestError("отправить отчёт", sendError));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="ovl">
      <button
        type="button"
        aria-label="Закрыть настройки"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="telegram-settings-title"
        className="sheet"
      >
        <div className="grab" aria-hidden>
          <i />
        </div>

        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-[#0a84ff]/70 via-transparent to-transparent"
        />

        <div className="flex items-start gap-3 pt-1">
          <div className="min-w-0 flex-1 pr-8">
            <h2
              id="telegram-settings-title"
              className="font-display text-[17px] font-semibold tracking-tight text-ink"
            >
              Настройки Telegram
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              Ежедневный дайджест заметок — по московскому времени.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть настройки"
            className="sheet-x"
          >
            ✕
          </button>
        </div>

        <div className="no-scrollbar max-h-[70dvh] overflow-y-auto pt-4">
          {isLoading ? (
            <div className="flex items-center gap-2 py-10 text-xs text-muted">
              <Spinner className="h-4 w-4" /> Загружаем настройки…
            </div>
          ) : (
            <div className="flex flex-col gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span className="field-label">Токен бота</span>
                <input
                  type="password"
                  value={form.bot_token}
                  onChange={(event) => updateField("bot_token", event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="123456789:AA…"
                  className="input font-mono text-[13px]"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="field-label">Chat ID</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.chat_id}
                  onChange={(event) => updateField("chat_id", event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="123456789"
                  className="input font-mono text-[13px]"
                />
                <span className="hint">Свой ID можно узнать у @userinfobot.</span>
              </label>

              <div className="glass-lite flex items-center gap-3 rounded-[18px] px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-ink">Отправлять ежедневный отчёт</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {lastSentDate
                      ? `Последняя отправка: ${formatSummaryDate(lastSentDate)}`
                      : "Сегодня ещё не отправляли"}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.is_active}
                  aria-label="Отправлять ежедневный отчёт"
                  onClick={() => updateField("is_active", !form.is_active)}
                  className={cn("switch", form.is_active && "switch-on")}
                >
                  <span className="switch-knob" />
                </button>
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="field-label">Время вечернего отчета (МСК)</span>
                <input
                  type="time"
                  step={300}
                  value={form.summary_time}
                  onChange={(event) =>
                    updateField("summary_time", event.target.value || DEFAULT_SUMMARY_TIME)
                  }
                  className="input tabular-nums sm:w-40"
                />
                <span className="hint">
                  Крон проверяет расписание каждые 30 минут и отправляет отчёт после указанного
                  времени.
                </span>
              </label>

              {error ? (
                <p
                  role="alert"
                  className="rounded-[14px] border border-[#ff453a]/30 bg-[#ff453a]/10 px-3 py-2 text-[11px] leading-relaxed text-[#ffb3ae]"
                >
                  {error}
                </p>
              ) : null}

              {notice ? (
                <p
                  role="status"
                  className="rounded-[14px] border border-[#30d158]/30 bg-[#30d158]/10 px-3 py-2 text-[11px] leading-relaxed text-[#7ee6a0]"
                >
                  {notice}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <div className="mt-1 flex flex-col gap-2 border-t border-stroke pt-3.5 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => void sendNow()}
            disabled={isLoading || isSaving || isSending}
            className="btn btn-sm"
          >
            {isSending ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <SendIcon className="h-3.5 w-3.5" />
            )}
            Отправить сейчас
          </button>

          <div className="flex items-center gap-2 sm:ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="rounded-pill px-4 py-2 text-xs font-bold text-muted transition hover:text-ink"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isLoading || isSaving || isSending}
              className="btn btn-sm btn-prime"
            >
              {isSaving ? <Spinner tone="dark" className="h-3.5 w-3.5" /> : null}
              Сохранить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.7-1.2-1.8-3.1-2 .8a7.7 7.7 0 0 0-2.6-1.5L14.4 3h-3.6l-.3 2.5a7.7 7.7 0 0 0-2.6 1.5l-2-.8-1.8 3.1 1.7 1.2a7.6 7.6 0 0 0 0 3l-1.7 1.2 1.8 3.1 2-.8a7.7 7.7 0 0 0 2.6 1.5l.3 2.5h3.6l.3-2.5a7.7 7.7 0 0 0 2.6-1.5l2 .8 1.8-3.1-1.7-1.2Z" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
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
      <path d="M21 3 10.5 13.5" />
      <path d="M21 3l-6.5 18-4-7.5L3 9.5 21 3Z" />
    </svg>
  );
}

