import type { Metadata } from "next";
import { Manrope, Unbounded } from "next/font/google";
import "./globals.css";

/**
 * Шрифты перенесены из проекта «ОБОРОТ»: Unbounded (заголовки, цифры, бренд)
 * и Manrope (интерфейс). Оба с кириллицей, подключены через next/font —
 * файлы хостятся с нашего домена, без мигания подмены шрифта.
 */
const unbounded = Unbounded({
  variable: "--font-unbounded",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin", "cyrillic"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Jarvis Inbox",
  description: "Личный ассистент: канбан голосовых заметок, задач и идей.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ru"
      className={`${manrope.variable} ${unbounded.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-bg font-sans text-ink">{children}</body>
    </html>
  );
}

