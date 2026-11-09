import { NextResponse } from "next/server";

import { describeMissingColumn, describeMissingRelation, errorMessage } from "@/lib/api-error";
import { getSupabaseAdminClient } from "@/lib/supabase";
import {
  getMoscowTime,
  loadTelegramSettings,
  markSummarySent,
  parseSummaryTime,
  sendTelegramMessage,
  startOfMoscowDayIso,
  MOSCOW_TIME_ZONE,
  type MoscowTime,
} from "@/lib/telegram";

/**
 * GET|POST /api/cron/daily-summary[?force=true]
 *
 * Вызывается Vercel Cron раз в 30 минут и отправляет вечерний отчёт в Telegram,
 * когда московское время совпало с `summary_time` из `app_settings`.
 *
 * - `?force=true` — кнопка «Отправить сейчас»: игнорирует расписание, тумблер
 *   `is_active` и отметку `last_summary_date` (после ручной отправки дата не
 *   перезаписывается, чтобы вечерний отчёт всё равно ушёл по расписанию).
 * - Автоматический запуск пишет `last_summary_date = "YYYY-MM-DD"`, поэтому
 *   повторной отправки в тот же день не будет.
 * - Если задан `CRON_SECRET`, Vercel присылает `Authorization: Bearer <secret>`;
 *   для ручной отправки секрет не требуется.
 */

const NOTES_TABLE = "voice_notes";
const NOTES_FIELDS =
  "title, cleaned_text, raw_transcript, category, action_date, status, created_at, deleted_at";
const NOTES_FIELDS_NO_TRASH =
  "title, cleaned_text, raw_transcript, category, action_date, status, created_at";

/** Крон ходит каждые 30 минут — столько же длится окно отправки. */
const MATCH_WINDOW_MINUTES = 30;
const TELEGRAM_TEXT_LIMIT = 4000;
const MAX_ITEMS_PER_SECTION = 8;

const CATEGORY_ORDER = ["music", "business", "task", "thought"];
const CATEGORY_TITLES: Record<string, string> = {
  music: "🎵 Музыка",
  business: "💼 Бизнес",
  task: "⏱ Задачи",
  thought: "💡 Мысли",
};

type SummaryNote = {
  title: string | null;
  cleaned_text: string | null;
  raw_transcript: string | null;
  category: string | null;
  action_date: string | null;
  status: string | null;
  created_at: string | null;
  deleted_at?: string | null;
};

type SkipReason = "not_configured" | "inactive" | "not_scheduled_time" | "already_sent_today";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shorten(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function plural(count: number, forms: [string, string, string]): string {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return forms[0];
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return forms[1];
  }

  return forms[2];
}

function noteTitle(note: SummaryNote): string {
  return (
    shorten(note.title ?? "", 60) ||
    shorten(note.cleaned_text ?? note.raw_transcript ?? "", 60) ||
    "Без названия"
  );
}

function noteBody(note: SummaryNote): string {
  const source = ((note.cleaned_text ?? "") || (note.raw_transcript ?? "")).replace(/\s+/g, " ").trim();
  const titleSource = (note.title ?? "").replace(/\s+/g, " ").trim();

  if (!source || source === titleSource) {
    return "";
  }

  return shorten(source, 140);
}

function formatDeadline(value: string | null): string {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Заметки, созданные с начала московских суток; удалённые не попадают в отчёт. */
async function fetchTodayNotes(sinceIso: string): Promise<SummaryNote[]> {
  const supabase = getSupabaseAdminClient();
  const filtered = await supabase
    .from(NOTES_TABLE)
    .select(NOTES_FIELDS)
    .gte("created_at", sinceIso)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (!filtered.error) {
    return (filtered.data ?? []) as SummaryNote[];
  }

  if (!/deleted_at/i.test(errorMessage(filtered.error))) {
    throw filtered.error;
  }

  // Колонки deleted_at ещё нет — считаем все заметки активными.
  const fallback = await supabase
    .from(NOTES_TABLE)
    .select(NOTES_FIELDS_NO_TRASH)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });

  if (fallback.error) {
    throw fallback.error;
  }

  return (fallback.data ?? []) as SummaryNote[];
}

function categoryKey(note: SummaryNote): string {
  const raw = (note.category ?? "").replace(/\s+/g, " ").trim().toLowerCase();

  return raw || "без раздела";
}

/** Базовые разделы первыми, новые — по алфавиту. */
function groupNotes(notes: SummaryNote[]): Array<[string, SummaryNote[]]> {
  const buckets = new Map<string, SummaryNote[]>();

  for (const note of notes) {
    const key = categoryKey(note);
    buckets.set(key, [...(buckets.get(key) ?? []), note]);
  }

  const rank = (key: string) => {
    const index = CATEGORY_ORDER.indexOf(key);

    return index === -1 ? CATEGORY_ORDER.length : index;
  };

  return [...buckets.entries()].sort(
    (a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], "ru"),
  );
}

function formatNoteLine(note: SummaryNote): string {
  const mark = note.status === "done" ? "✅" : "•";
  const title = `<b>${escapeHtml(noteTitle(note))}</b>`;
  const body = noteBody(note);
  const deadline = formatDeadline(note.action_date);
  const suffix = deadline ? ` · ⏰ ${escapeHtml(deadline)}` : "";
  const text = body ? `${title} — ${escapeHtml(body)}` : title;

  return `${mark} ${text}${suffix}`;
}

/** HTML-сообщение для Telegram; всегда укладывается в лимит 4096 символов. */
function buildSummaryText(notes: SummaryNote[], label: string): string {
  const header = `<b>Итоги дня</b> · ${escapeHtml(label)}`;

  if (notes.length === 0) {
    return `${header}\n\nСегодня новых заметок не было — тишина и порядок.`;
  }

  const done = notes.filter((note) => note.status === "done").length;
  const sections = groupNotes(notes).map(([key, group]) => {
    const title =
      CATEGORY_TITLES[key] ?? escapeHtml(key.charAt(0).toUpperCase() + key.slice(1));
    const lines = group.slice(0, MAX_ITEMS_PER_SECTION).map(formatNoteLine);

    if (group.length > lines.length) {
      lines.push(`…и ещё ${group.length - lines.length}`);
    }

    return `<b>${title}</b> · ${group.length}\n${lines.join("\n")}`;
  });

  let text = `${header}\nЗаметок: ${notes.length} · выполнено ${done}`;

  for (let index = 0; index < sections.length; index += 1) {
    const section = `\n\n${sections[index]}`;

    if (text.length + section.length > TELEGRAM_TEXT_LIMIT) {
      const omitted = sections.length - index;

      text += `\n\n…и ещё ${omitted} ${plural(omitted, ["раздел", "раздела", "разделов"])}`;
      break;
    }

    text += section;
  }

  return text;
}

function skippedResponse(
  reason: SkipReason,
  meta: { moscow: MoscowTime; scheduledTime: string; forced: boolean },
) {
  const moscowTime = `${pad(meta.moscow.hours)}:${pad(meta.moscow.minutes)}`;
  const detail: Record<SkipReason, string> = {
    not_configured: "Не заданы токен бота или chat_id — заполните их в настройках.",
    inactive: "Отправка ежедневного отчёта выключена тумблером в настройках.",
    not_scheduled_time: `Сейчас ${moscowTime} МСК, отчёт запланирован на ${meta.scheduledTime}.`,
    already_sent_today: `Отчёт за ${meta.moscow.date} уже отправлен.`,
  };

  return NextResponse.json({
    status: "skipped",
    reason,
    detail: detail[reason],
    scheduled_time: meta.scheduledTime,
    moscow_date: meta.moscow.date,
    moscow_time: moscowTime,
    forced: meta.forced,
  });
}

async function handleSummaryRequest(request: Request) {
  const force = ["true", "1"].includes(
    (new URL(request.url).searchParams.get("force") ?? "").toLowerCase(),
  );

  const cronSecret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");

  // Vercel Cron присылает `Authorization: Bearer ${CRON_SECRET}`.
  if (cronSecret && !force && authorization !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { status: "error", error: "Неверный или отсутствующий CRON_SECRET." },
      { status: 401 },
    );
  }

  try {
    const settings = await loadTelegramSettings();
    const moscow = getMoscowTime();
    const meta = { moscow, scheduledTime: settings.summary_time, forced: force };

    if (!settings.bot_token || !settings.chat_id) {
      return skippedResponse("not_configured", meta);
    }

    if (!settings.is_active && !force) {
      return skippedResponse("inactive", meta);
    }

    if (!force) {
      const scheduledMinutes = parseSummaryTime(settings.summary_time);
      const diff = moscow.minutesOfDay - scheduledMinutes;

      // Окно запуска: отчёт уходит не раньше запланированного времени и не позже
      // чем через MATCH_WINDOW_MINUTES (крон ходит каждые полчаса).
      if (diff < 0 || diff > MATCH_WINDOW_MINUTES) {
        return skippedResponse("not_scheduled_time", meta);
      }

      if (settings.last_summary_date === moscow.date) {
        return skippedResponse("already_sent_today", meta);
      }
    }

    const notes = await fetchTodayNotes(startOfMoscowDayIso(moscow.date));
    const text = buildSummaryText(notes, moscow.label);
    const messageId = await sendTelegramMessage(settings.bot_token, settings.chat_id, text);

    if (!force) {
      try {
        await markSummarySent(moscow.date);
      } catch (markError) {
        // Сообщение уже улетело — не роняем ответ, но фиксируем проблему.
        console.error("[daily-summary] Не удалось записать last_summary_date", {
          message: errorMessage(markError),
        });
      }
    }

    return NextResponse.json({
      status: "ok",
      data: {
        sent_at: new Date().toISOString(),
        date: moscow.date,
        summary_time: settings.summary_time,
        notes: notes.length,
        message_id: messageId,
        forced: force,
      },
    });
  } catch (error) {
    const message = describeMissingRelation(describeMissingColumn(errorMessage(error)));

    console.error("[daily-summary] Не удалось отправить отчёт", { message, error });

    return NextResponse.json(
      { status: "error", error: `Не удалось отправить отчёт: ${message}` },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handleSummaryRequest(request);
}

export async function POST(request: Request) {
  return handleSummaryRequest(request);
}
