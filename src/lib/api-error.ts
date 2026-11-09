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
  if (/column .* does not exist/i.test(message)) {
    return `В таблице voice_notes нет нужной колонки: ${message}. Примените миграцию (subcategory, deleted_at) из README.`;
  }

  return message;
}
