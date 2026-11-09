import { NextResponse } from "next/server";

import { describeMissingColumn, errorMessage } from "@/lib/api-error";
import { getSupabaseAdminClient } from "@/lib/supabase";

/**
 * PATCH /api/voice-notes/[id]
 *   `{ "deleted": true }`  — мягкое удаление: `deleted_at = now()`;
 *   `{ "deleted": false }` — восстановление из корзины;
 *   `{ "status": "inbox" | "done" }` — переключение статуса карточки.
 *
 * DELETE /api/voice-notes/[id]
 *   Физическое удаление: сначала объект из бакета `voice-records`,
 *   затем строка в таблице `voice_notes`.
 *
 * Оба метода работают через admin-клиент (service_role), поэтому не зависят
 * от RLS-политик UPDATE/DELETE для anon-ключа.
 */

const VOICE_NOTES_TABLE = "voice_notes";
const STORAGE_BUCKET = "voice-records";

/** В Next 15+ сегментные параметры роута приходят асинхронно. */
type RouteContext = { params: Promise<{ id: string }> };

type PatchBody = {
  deleted?: unknown;
  status?: unknown;
};

type NoteRef = {
  id: string;
  audio_url: string | null;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ status: "error", error }, { status });
}

function okResponse(id: string) {
  return NextResponse.json({ status: "ok", data: { id } });
}

function describeWriteFailure(error: unknown): string {
  return describeMissingColumn(errorMessage(error));
}

/**
 * Достаёт путь объекта в бакете из публичного URL Supabase Storage:
 * `.../storage/v1/object/public/voice-records/<path>` → `<path>`.
 */
function extractStoragePath(audioUrl: string | null): string | null {
  if (!audioUrl) {
    return null;
  }

  const marker = `/object/public/${STORAGE_BUCKET}/`;
  const markerIndex = audioUrl.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const path = audioUrl.slice(markerIndex + marker.length).split("?")[0];

  return path ? decodeURIComponent(path) : null;
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;

  let body: PatchBody;

  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return errorResponse("Ожидается JSON-тело запроса.", 400);
  }

  const patch: { status?: "inbox" | "done"; deleted_at?: string | null } = {};

  if (body.status === "inbox" || body.status === "done") {
    patch.status = body.status;
  }

  if (typeof body.deleted === "boolean") {
    patch.deleted_at = body.deleted ? new Date().toISOString() : null;
  }

  if (Object.keys(patch).length === 0) {
    return errorResponse('Нужно передать "status" или "deleted".', 400);
  }

  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from(VOICE_NOTES_TABLE)
      .update(patch)
      .eq("id", id)
      .select("id")
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return errorResponse("Заметка не найдена.", 404);
    }

    return okResponse(id);
  } catch (error) {
    const message = describeWriteFailure(error);

    console.error("[voice-notes] Не удалось обновить заметку", { id, patch, message, error });

    return errorResponse(`Не удалось обновить заметку: ${message}`, 500);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from(VOICE_NOTES_TABLE)
      .select("id, audio_url")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return errorResponse("Заметка не найдена.", 404);
    }

    const note = data as NoteRef;
    const storagePath = extractStoragePath(note.audio_url);

    if (storagePath) {
      const { error: removeError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove([storagePath]);

      if (removeError) {
        // Файл мог быть уже удалён вручную — строку из таблицы всё равно чистим.
        console.error("[voice-notes] Не удалось удалить аудио из Storage", {
          id,
          storagePath,
          message: errorMessage(removeError),
        });
      }
    }

    const { error: deleteError } = await supabase.from(VOICE_NOTES_TABLE).delete().eq("id", id);

    if (deleteError) {
      throw deleteError;
    }

    return okResponse(id);
  } catch (error) {
    const message = describeWriteFailure(error);

    console.error("[voice-notes] Не удалось удалить заметку", { id, message, error });

    return errorResponse(`Не удалось удалить заметку: ${message}`, 500);
  }
}
