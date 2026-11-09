import { NextResponse } from "next/server";
import { createClient, type DeepgramClient } from "@deepgram/sdk";

import { getSupabaseAdminClient } from "@/lib/supabase";

/**
 * POST /api/voice-inbox
 *
 * Конвейер обработки голосовой заметки:
 *   1. multipart/form-data с полем `audio`;
 *   2. загрузка исходника в Supabase Storage (bucket `voice-records`);
 *   3. расшифровка через Deepgram (`nova-3`, русский язык);
 *   4. классификация через DeepSeek (`deepseek-chat`);
 *   5. запись результата в таблицу `voice_notes`;
 *   6. ответ `{ status: "ok", data: insertedRecord }`.
 */

/**
 * Собственный лимит на размер аудио: Deepgram принимает до 2 GB, но такой файл
 * не стоит целиком держать в памяти роута.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Имя поля с аудиофайлом в multipart/form-data. */
const AUDIO_FIELD = "audio";

/** Бакет Supabase Storage с исходными записями. */
const STORAGE_BUCKET = "voice-records";

/** Таблица с обработанными заметками. */
const VOICE_NOTES_TABLE = "voice_notes";

/** Модель и язык Deepgram для расшифровки аудио. */
const DEEPGRAM_MODEL = "nova-3";
const DEEPGRAM_LANGUAGE = "ru";

/** DeepSeek Chat Completions endpoint и модель. */
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

/** Таймаут запроса к DeepSeek, чтобы роут не висел бесконечно. */
const DEEPSEEK_TIMEOUT_MS = 60_000;

const CATEGORIES = ["music", "business", "task", "thought"] as const;

type Category = (typeof CATEGORIES)[number];

type Classification = {
  category: Category;
  title: string;
  cleaned_text: string;
  action_date: string | null;
};

type ErrorResponse = {
  status: "error";
  error: string;
};

type DeepSeekChatCompletion = {
  choices?: Array<{ message?: { content?: string | null } }>;
};

type SupabaseAdminClient = ReturnType<typeof getSupabaseAdminClient>;

let deepgramClient: DeepgramClient | null = null;

function errorResponse(error: string, status: number) {
  return NextResponse.json({ status: "error", error } satisfies ErrorResponse, {
    status,
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Не задана переменная окружения ${name}. Добавьте её в .env.local`);
  }

  return value;
}

/**
 * Клиент Deepgram создаётся лениво: модуль роута импортируется во время `next build`,
 * а переменные окружения на этом этапе могут быть недоступны.
 */
function getDeepgramClient(): DeepgramClient {
  if (!deepgramClient) {
    deepgramClient = createClient(requireEnv("DEEPGRAM_API_KEY"));
  }

  return deepgramClient;
}

/** Подробный лог ошибки шага: видно, какой сервис упал, с какими данными и почему. */
function logStepError(
  step: string,
  context: Record<string, unknown>,
  error?: unknown,
) {
  if (error === undefined) {
    console.error(`[voice-inbox] ${step}`, context);

    return;
  }

  console.error(`[voice-inbox] ${step}`, context, error);
}

/** Системный промпт классификатора. Время фиксируется на момент запроса. */
function buildSystemPrompt(): string {
  return `Ты — персональный секретарь и классификатор входящих мыслей. Текущее время ISO: ${new Date().toISOString()}.
Проанализируй входящую мысль и распредели по категориям:
- 'music': автор напевает мелодию, рифмы, гармонию, темп, слова трека или говорит 'придумал мотив/мелодию'.
- 'business': бизнес-идеи, коммерция, монетизация, оптимизация процессов, продажи.
- 'task': конкретная задача или бытовое дело (особенно если есть фразы вроде 'надо сделать', 'поставь напоминание на 14:00').
- 'thought': пассивные рассуждения, личные мысли, дневник.

Верни строго JSON объект:
{
  "category": "music" | "business" | "task" | "thought",
  "title": "Короткий емкий заголовок (до 5 слов)",
  "cleaned_text": "Текст мысли без мычания, пауз и слов-паразитов",
  "action_date": "ISO-дата дедлайна если была названа, иначе null"
}`;
}

type ServiceErrorDetails = {
  name: string;
  status: number | null;
  message: string;
  code: string | null;
  detail: string | null;
  requestId: string | null;
  body: Record<string, unknown> | null;
};

/** Пытается разобрать строку как JSON-объект: тело ошибки Deepgram приходит именно так. */
function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);

    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Не JSON — вызывающая сторона использует исходный текст сообщения.
    return null;
  }
}

/**
 * Достаёт из ошибки SDK статус и тело ответа.
 *
 * Deepgram бросает `DeepgramApiError` с числовым `status`, а тело ответа
 * (`{"err_code":"…","err_msg":"…","request_id":"…"}`) кладёт строкой в `message`.
 */
function extractErrorDetails(error: unknown): ServiceErrorDetails {
  const message = error instanceof Error ? error.message : String(error);
  const parsed = parseJsonObject(message);
  const serviceError = error as { status?: unknown } | null;

  return {
    name: error instanceof Error ? error.name : "UnknownError",
    status: typeof serviceError?.status === "number" ? serviceError.status : null,
    message,
    code: typeof parsed?.err_code === "string" ? parsed.err_code : null,
    detail: typeof parsed?.err_msg === "string" ? parsed.err_msg : null,
    requestId: typeof parsed?.request_id === "string" ? parsed.request_id : null,
    body: parsed,
  };
}

/** Понятное пользователю сообщение об ошибке Deepgram по HTTP-статусу. */
function describeDeepgramFailure(status: number | null): string {
  switch (status) {
    case 400:
      return "Deepgram не смог обработать аудио (400): запись повреждена или формат не поддерживается.";
    case 401:
    case 403:
      return "Deepgram отклонил API-ключ (401/403). Проверьте DEEPGRAM_API_KEY.";
    case 402:
      return "У ключа Deepgram закончился баланс (402).";
    case 413:
      return "Аудиофайл слишком большой для Deepgram (413).";
    case 429:
      return "Deepgram ограничил частоту запросов (429). Повторите через минуту.";
    default:
      return "Не удалось распознать речь (ошибка сервиса распознавания).";
  }
}

/**
 * Расшифровка аудио через Deepgram (`nova-3`, русский язык). Возвращает непустой текст.
 *
 * Браузерный `File` читаем целиком в Buffer и отдаём SDK напрямую: Deepgram сам
 * определяет контейнер записи (webm/opus из Chrome, mp4 из Safari, ogg, wav).
 */
async function transcribeAudio(audio: File): Promise<string> {
  const deepgram = getDeepgramClient();
  const buffer = Buffer.from(await audio.arrayBuffer());
  const mimeType = audio.type || "audio/m4a";

  console.info("[voice-inbox] Deepgram: отправляю аудио", {
    model: DEEPGRAM_MODEL,
    language: DEEPGRAM_LANGUAGE,
    mimeType,
    bytes: buffer.byteLength,
  });

  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(buffer, {
    model: DEEPGRAM_MODEL,
    language: DEEPGRAM_LANGUAGE,
    smart_format: true,
    mimetype: mimeType,
  });

  if (error || !result) {
    throw error ?? new Error("Deepgram transcription failed");
  }

  const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

  return transcript.trim();
}

function isCategory(value: unknown): value is Category {
  return (
    typeof value === "string" && (CATEGORIES as readonly string[]).includes(value)
  );
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

/** Заголовок из первых пяти слов — используется, если LLM его не вернула. */
function buildTitle(text: string): string {
  const title = text.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");

  return title || "Без названия";
}

function normalizeActionDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed || ["null", "none", "n/a"].includes(trimmed.toLowerCase())) {
    return null;
  }

  return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
}

/** LLM иногда оборачивает JSON в markdown-ограждение — снимаем его перед парсингом. */
function extractJsonPayload(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);

  return fenced ? fenced[1].trim() : trimmed;
}

function fallbackClassification(rawTranscript: string): Classification {
  return {
    category: "thought",
    title: buildTitle(rawTranscript),
    cleaned_text: rawTranscript,
    action_date: null,
  };
}

/**
 * Разбор ответа DeepSeek. Любое отклонение от схемы не роняет запрос:
 * используется fallback `thought` + исходная расшифровка.
 */
function parseClassification(
  content: string,
  rawTranscript: string,
): Classification {
  const fallback = fallbackClassification(rawTranscript);

  let payload: unknown;

  try {
    payload = JSON.parse(extractJsonPayload(content));
  } catch (error) {
    logStepError(
      "DeepSeek вернул не-JSON, использую fallback",
      { content: content.slice(0, 500) },
      error,
    );

    return fallback;
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    logStepError("DeepSeek вернул JSON не в виде объекта, использую fallback", {
      payload,
    });

    return fallback;
  }

  const candidate = payload as Record<string, unknown>;

  if (!isCategory(candidate.category)) {
    logStepError("DeepSeek вернул неизвестную категорию, использую fallback", {
      category: candidate.category,
    });
  }

  return {
    category: isCategory(candidate.category) ? candidate.category : fallback.category,
    title: asNonEmptyString(candidate.title) ?? fallback.title,
    cleaned_text: asNonEmptyString(candidate.cleaned_text) ?? fallback.cleaned_text,
    action_date: normalizeActionDate(candidate.action_date),
  };
}

/** Классификация расшифровки через DeepSeek Chat Completions (JSON-режим). */
async function classifyTranscript(rawTranscript: string): Promise<Classification> {
  const apiKey = requireEnv("DEEPSEEK_API_KEY");

  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0.0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: rawTranscript },
      ],
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");

    logStepError(
      "DeepSeek API вернул ошибку",
      {
        status: response.status,
        statusText: response.statusText,
        body: errorBody.slice(0, 1000),
      },
      new Error(`DeepSeek API responded with ${response.status}`),
    );

    throw new Error(`DeepSeek API responded with ${response.status}`);
  }

  const payload = (await response.json()) as DeepSeekChatCompletion;
  const content = payload.choices?.[0]?.message?.content ?? "";

  if (!content.trim()) {
    logStepError("DeepSeek вернул пустой ответ, использую fallback", {
      transcriptLength: rawTranscript.length,
    });
  }

  return parseClassification(content, rawTranscript);
}

export async function POST(request: Request) {
  // --- Валидация -----------------------------------------------------------
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return errorResponse('Ожидается Content-Type "multipart/form-data".', 415);
  }

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch (error) {
    logStepError("Не удалось разобрать multipart/form-data", {}, error);

    return errorResponse("Не удалось разобрать multipart/form-data тело запроса.", 400);
  }

  const audio = formData.get(AUDIO_FIELD);

  if (!(audio instanceof File)) {
    return errorResponse(`В запросе нет файла в поле "${AUDIO_FIELD}".`, 400);
  }

  if (audio.size === 0) {
    return errorResponse("Аудиофайл пустой.", 400);
  }

  if (audio.size > MAX_AUDIO_BYTES) {
    return errorResponse("Аудиофайл больше 25 MB.", 413);
  }

  // --- 1. Supabase Storage -------------------------------------------------
  let supabase: SupabaseAdminClient;

  try {
    supabase = getSupabaseAdminClient();
  } catch (error) {
    logStepError("Не удалось создать Supabase admin-клиент", {}, error);

    return errorResponse("Сервис хранения недоступен.", 500);
  }

  const fileName = `${Date.now()}-${crypto.randomUUID()}.m4a`;
  const storage = supabase.storage.from(STORAGE_BUCKET);
  const uploadContentType = audio.type || "audio/m4a";

  const { error: uploadError } = await storage.upload(fileName, audio, {
    contentType: uploadContentType,
    upsert: false,
  });

  if (uploadError) {
    logStepError(
      "Supabase Storage: не удалось загрузить аудио",
      {
        bucket: STORAGE_BUCKET,
        fileName,
        size: audio.size,
        contentType: uploadContentType,
      },
      uploadError,
    );

    return errorResponse("Не удалось сохранить аудиофайл.", 500);
  }

  const { data: publicUrlData } = storage.getPublicUrl(fileName);
  const audioUrl = publicUrlData.publicUrl;

  // --- 2. Транскрипция (Deepgram nova-3) -----------------------------------
  let rawTranscript: string;

  try {
    rawTranscript = await transcribeAudio(audio);
  } catch (error) {
    const deepgramError = extractErrorDetails(error);

    logStepError("Deepgram: не удалось расшифровать аудио", {
      model: DEEPGRAM_MODEL,
      language: DEEPGRAM_LANGUAGE,
      fileName,
      audioUrl,
      size: audio.size,
      mimeType: audio.type || "unknown",
      name: deepgramError.name,
      status: deepgramError.status,
      message: deepgramError.message,
      code: deepgramError.code,
      detail: deepgramError.detail,
      requestId: deepgramError.requestId,
      error: deepgramError.body,
    });

    return errorResponse(describeDeepgramFailure(deepgramError.status), 502);
  }

  if (!rawTranscript) {
    logStepError("Deepgram: расшифровка пустая", { fileName, audioUrl });

    return errorResponse("Не удалось распознать речь", 400);
  }

  // --- 3. Классификация (DeepSeek) -----------------------------------------
  let classification: Classification;

  try {
    classification = await classifyTranscript(rawTranscript);
  } catch (error) {
    logStepError(
      "DeepSeek: не удалось классифицировать заметку",
      { audioUrl, transcriptLength: rawTranscript.length },
      error,
    );

    return errorResponse("Не удалось классифицировать заметку.", 502);
  }

  // --- 4. Сохранение в Supabase --------------------------------------------
  const { data: insertedRecord, error: insertError } = await supabase
    .from(VOICE_NOTES_TABLE)
    .insert({
      audio_url: audioUrl,
      raw_transcript: rawTranscript,
      title: classification.title,
      category: classification.category,
      cleaned_text: classification.cleaned_text,
      action_date: classification.action_date,
      status: "inbox",
    })
    .select()
    .single();

  if (insertError) {
    logStepError(
      "Supabase: не удалось сохранить заметку",
      {
        table: VOICE_NOTES_TABLE,
        audioUrl,
        category: classification.category,
      },
      insertError,
    );

    return errorResponse("Не удалось сохранить заметку.", 500);
  }

  console.info("[voice-inbox] Заметка сохранена", {
    noteId: insertedRecord?.id,
    category: classification.category,
    audioUrl,
  });

  return NextResponse.json({ status: "ok", data: insertedRecord });
}

