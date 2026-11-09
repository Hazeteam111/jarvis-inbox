import { NextResponse } from "next/server";

import { describeMissingColumn, describeMissingRelation, errorMessage } from "@/lib/api-error";
import {
  loadTelegramSettings,
  normalizeBotToken,
  normalizeChatId,
  normalizeSummaryTime,
  saveTelegramSettings,
  type TelegramSettings,
} from "@/lib/telegram";

/**
 * GET  /api/settings/telegram — текущие настройки бота и расписания.
 * POST /api/settings/telegram — сохранить `bot_token`, `chat_id`, `is_active`
 *                               и `summary_time` (формат `HH:mm`, по умолчанию `21:30`).
 *
 * Хранилище — единственная строка `app_settings` (`id = 1`), доступ через
 * service_role, поэтому RLS-политики для интерфейса не нужны.
 */

type SettingsBody = {
  bot_token?: unknown;
  chat_id?: unknown;
  is_active?: unknown;
  summary_time?: unknown;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ status: "error", error }, { status });
}

/** Тумблер может прийти как boolean или как строка из формы. */
function normalizeIsActive(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true" || value === "on" || value === 1) {
    return true;
  }

  if (value === "false" || value === "off" || value === 0) {
    return false;
  }

  return null;
}

function describeSettingsError(error: unknown): string {
  return describeMissingRelation(describeMissingColumn(errorMessage(error)));
}

export async function GET() {
  try {
    const settings = await loadTelegramSettings();

    return NextResponse.json({ status: "ok", data: settings });
  } catch (error) {
    const message = describeSettingsError(error);

    console.error("[settings/telegram] Не удалось прочитать настройки", { message, error });

    return errorResponse(`Не удалось загрузить настройки Telegram: ${message}`, 500);
  }
}

export async function POST(request: Request) {
  const raw = await request.json().catch(() => null);

  if (raw === null) {
    return errorResponse("Ожидается JSON-тело запроса.", 400);
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return errorResponse("Ожидается JSON-объект с настройками.", 400);
  }

  const body = raw as SettingsBody;

  const patch: Partial<TelegramSettings> = {};

  if ("bot_token" in body) {
    patch.bot_token = normalizeBotToken(body.bot_token);
  }

  if ("chat_id" in body) {
    patch.chat_id = normalizeChatId(body.chat_id);
  }

  if ("summary_time" in body) {
    patch.summary_time = normalizeSummaryTime(body.summary_time);
  }

  if ("is_active" in body) {
    const isActive = normalizeIsActive(body.is_active);

    if (isActive === null) {
      return errorResponse('Поле "is_active" должно быть boolean.', 400);
    }

    patch.is_active = isActive;
  }

  if (Object.keys(patch).length === 0) {
    return errorResponse('Нужно передать хотя бы одно поле: "bot_token", "chat_id", "is_active", "summary_time".', 400);
  }

  try {
    const current = await loadTelegramSettings();
    const next = { ...current, ...patch };

    if (next.is_active && (!next.bot_token || !next.chat_id)) {
      return errorResponse("Чтобы включить отправку, заполните токен бота и chat_id.", 400);
    }

    const saved = await saveTelegramSettings(patch);

    return NextResponse.json({ status: "ok", data: saved });
  } catch (error) {
    const message = describeSettingsError(error);

    console.error("[settings/telegram] Не удалось сохранить настройки", { message, error });

    return errorResponse(`Не удалось сохранить настройки Telegram: ${message}`, 500);
  }
}
