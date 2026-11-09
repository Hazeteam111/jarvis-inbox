import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Клиенты Supabase для "Jarvis Voice Inbox".
 *
 * - `getSupabaseBrowserClient()` — anon key, безопасен для клиентских компонентов
 *   (доступ к данным ограничен RLS-политиками).
 * - `getSupabaseAdminClient()` — service_role key, только сервер
 *   (запись в БД и загрузка файлов в Storage). Никогда не импортировать
 *   в клиентские компоненты.
 *
 * Клиенты создаются лениво и кешируются, поэтому `next build` не падает,
 * если переменные окружения ещё не заполнены.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let browserClient: SupabaseClient | null = null;
let adminClient: SupabaseClient | null = null;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `[supabase] Не задана переменная окружения ${name}. Добавьте её в .env.local`,
    );
  }

  return value;
}

/** Клиент для браузера: чтение данных по RLS и работа с сессией пользователя. */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    browserClient = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL),
      requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", SUPABASE_ANON_KEY),
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      },
    );
  }

  return browserClient;
}

/** Серверный клиент с service_role: обходит RLS, использовать только в route handlers. */
export function getSupabaseAdminClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error(
      "[supabase] getSupabaseAdminClient() доступен только на сервере.",
    );
  }

  if (!adminClient) {
    adminClient = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
  }

  return adminClient;
}
