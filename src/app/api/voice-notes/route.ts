import { NextResponse } from "next/server";

import { describeMissingColumn, errorMessage } from "@/lib/api-error";
import { getSupabaseAdminClient } from "@/lib/supabase";

/**
 * GET /api/voice-notes
 *
 * Отдаёт данные для дашборда: активные заметки и корзину. Чтение идёт через
 * admin-клиент (service_role), поэтому интерфейс не зависит от RLS-политик
 * таблицы `voice_notes`.
 *
 * Ответ: `{ status: "ok", data: { active, trash } }`.
 */

const VOICE_NOTES_TABLE = "voice_notes";

/** Поля, которые нужны канбану и корзине. */
const NOTE_FIELDS =
  "id, audio_url, raw_transcript, title, category, subcategory, cleaned_text, action_date, status, created_at, deleted_at";

type VoiceNoteRow = {
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



export async function GET() {
  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from(VOICE_NOTES_TABLE)
      .select(NOTE_FIELDS)
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    const notes = (data ?? []) as VoiceNoteRow[];

    return NextResponse.json({
      status: "ok",
      data: {
        active: notes.filter((note) => !note.deleted_at),
        trash: notes.filter((note) => note.deleted_at),
      },
    });
  } catch (error) {
    const message = describeMissingColumn(errorMessage(error));

    console.error("[voice-notes] Не удалось загрузить заметки", { message, error });

    return NextResponse.json(
      { status: "error", error: `Не удалось загрузить заметки: ${message}` },
      { status: 500 },
    );
  }
}
