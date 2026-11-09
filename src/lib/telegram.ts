import { getSupabaseAdminClient } from "@/lib/supabase";

/**
 * Настройки Telegram-бота и ежедневного дайджеста.
 *
 * Хранятся в единственной строке таблицы `app_settings` (`id = 1`):
 * `bot_token`, `chat_id`, `is_active`, `summary_time`, `last_summary_date`.
 * Чтение и запись идут через admin-клиент (service_role).
 */

const SETTINGS_TABLE = "app_settings";
const SETTINGS_ID = 1;
const SETTINGS_FIELDS = "bot_token, chat_id, is_active, summary_time, last_summary_date";

const MAX_TOKEN_LENGTH = 200;
const MAX_CHAT_ID_LENGTH = 64;
const SUMMARY_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MINUTES_IN_DAY = 24 * 60;

/** Время отчёта по умолчанию (московское). */
export const DEFAULT_SUMMARY_TIME = "21:30";

/** Москва живёт в UTC+3 без перехода на летнее время. */
export const MOSCOW_TIME_ZONE = "Europe/Moscow";

export type TelegramSettings = {
  bot_token: string;
  chat_id: string;
  is_active: boolean;
  summary_time: string;
  last_summary_date: string | null;
};

type SettingsRow = {
  bot_token: string | null;
  chat_id: string | null;
  is_active: boolean | null;
  summary_time: string | null;
  last_summary_date: string | null;
};

export type MoscowTime = {
  /** `YYYY-MM-DD` по Москве — ключ для `last_summary_date`. */
  date: string;
  hours: number;
  minutes: number;
  minutesOfDay: number;
  /** «9 ноября» для заголовка отчёта. */
  label: string;
};

/** «21:5» → «21:30»: любое некорректное значение откатывается к дефолту. */
export function normalizeSummaryTime(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();

    if (SUMMARY_TIME_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }

  return DEFAULT_SUMMARY_TIME;
}

export function normalizeBotToken(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_TOKEN_LENGTH) : "";
}

export function normalizeChatId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_CHAT_ID_LENGTH) : "";
}

export function toTelegramSettings(row: Partial<SettingsRow> | null | undefined): TelegramSettings {
  return {
    bot_token: normalizeBotToken(row?.bot_token),
    chat_id: normalizeChatId(row?.chat_id),
    is_active: Boolean(row?.is_active),
    summary_time: normalizeSummaryTime(row?.summary_time),
    last_summary_date: row?.last_summary_date ?? null,
  };
}

/** Настройки из БД; если строки ещё нет — дефолты (`21:30`, выключено). */
export async function loadTelegramSettings(): Promise<TelegramSettings> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .select(SETTINGS_FIELDS)
    .eq("id", SETTINGS_ID)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return toTelegramSettings(data as SettingsRow | null);
}

/** Частичное обновление: переданные поля накладываются на текущие настройки. */
export async function saveTelegramSettings(patch: Partial<TelegramSettings>): Promise<TelegramSettings> {
  const current = await loadTelegramSettings();
  const next: TelegramSettings = { ...current, ...patch };

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .upsert(
      {
        id: SETTINGS_ID,
        bot_token: normalizeBotToken(next.bot_token) || null,
        chat_id: normalizeChatId(next.chat_id) || null,
        is_active: Boolean(next.is_active),
        summary_time: normalizeSummaryTime(next.summary_time),
        last_summary_date: next.last_summary_date,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    .select(SETTINGS_FIELDS)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return toTelegramSettings((data as SettingsRow | null) ?? next);
}

/** Запоминаем дату отправки, чтобы отчёт не улетел дважды за день. */
export async function markSummarySent(date: string): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from(SETTINGS_TABLE)
    .update({ last_summary_date: date, updated_at: new Date().toISOString() })
    .eq("id", SETTINGS_ID);

  if (error) {
    throw error;
  }
}

/** Текущее московское время, посчитанное через Intl (без ручных сдвигов). */
export function getMoscowTime(now: Date = new Date()): MoscowTime {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: MOSCOW_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";

  const hours = Number(pick("hour")) % 24;
  const minutes = Number(pick("minute"));
  const date = `${pick("year")}-${pick("month")}-${pick("day")}`;
  const label = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TIME_ZONE,
    day: "numeric",
    month: "long",
  }).format(now);

  return { date, hours, minutes, minutesOfDay: hours * 60 + minutes, label };
}

/** «21:30» → 1290 минут от начала суток. */
export function parseSummaryTime(value: string): number {
  const [hours, minutes] = normalizeSummaryTime(value).split(":").map(Number);

  return (hours % 24) * 60 + (minutes % MINUTES_IN_DAY);
}

/** Начало московских суток в ISO-формате для фильтра `created_at`. */
export function startOfMoscowDayIso(date: string): string {
  return `${date}T00:00:00+03:00`;
}

type TelegramApiResponse = {
  ok?: boolean;
  description?: string;
  result?: { message_id?: number };
};

/** `sendMessage` в Bot API; бросает ошибку с описанием от Telegram. */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<number | null> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as TelegramApiResponse | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.description ?? `Telegram API ответил HTTP ${response.status}.`);
  }

  return payload.result?.message_id ?? null;
}
