/**
 * Читаемый текст ошибки из чего угодно: `Error`, `PostgrestError` (это обычный
 * объект с полем `message`), строка или неизвестное значение.
 *
 * Нужен, потому что supabase-js бросает не только `Error`, а лог и ответ API
 * должны оставаться человекочитаемыми.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error as { message?: unknown };

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return String(error);
}

/** Подсказка про миграцию, если в таблице нет новых колонок. */
export function describeMissingColumn(message: string): string {
  if (!/column .* does not exist/i.test(message)) {
    return message;
  }

  if (/app_settings/i.test(message)) {
    return `В таблице app_settings нет нужной колонки: ${message}. Примените SQL из README (summary_time, last_summary_date).`;
  }

  return `В таблице voice_notes нет нужной колонки: ${message}. Примените миграцию (subcategory, deleted_at) из README.`;
}

/** Подсказка про SQL, если в базе ещё нет таблицы настроек. */
export function describeMissingRelation(message: string): string {
  const mentionsSettings = /app_settings/i.test(message);
  const looksMissing = /does not exist|could not find the table|schema cache/i.test(message);

  if (mentionsSettings && looksMissing) {
    return `В базе нет таблицы app_settings: ${message}. Создайте её по SQL из README.`;
  }

  return message;
}
