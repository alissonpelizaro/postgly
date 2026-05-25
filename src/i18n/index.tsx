import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { en, type Dict } from "./dictionaries/en";
import { pt } from "./dictionaries/pt";
import { es } from "./dictionaries/es";

export type Language = "en" | "pt" | "es";

export const LANGUAGES: { code: Language; label: string; flag: string }[] = [
  { code: "en", label: "English",    flag: "🇺🇸" },
  { code: "pt", label: "Português",  flag: "🇧🇷" },
  { code: "es", label: "Español",    flag: "🇪🇸" },
];

const DICTS: Record<Language, Dict> = { en, pt, es };
const STORAGE_KEY = "postgly-lang";

interface I18nContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (path: TKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectInitial(): Language {
  const stored = localStorage.getItem(STORAGE_KEY) as Language | null;
  if (stored && stored in DICTS) return stored;
  const nav = navigator.language?.toLowerCase() ?? "en";
  if (nav.startsWith("pt")) return "pt";
  if (nav.startsWith("es")) return "es";
  return "en";
}

/** Generate dot-paths to string leaves of the dictionary. */
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends object
      ? Leaves<T[K], `${P}${K}.`>
      : never;
}[keyof T & string];

export type TKey = Leaves<Dict>;

function lookup(dict: Dict, path: string): string {
  const parts = path.split(".");
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return path;
    }
  }
  return typeof cur === "string" ? cur : path;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Language>(detectInitial);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Language) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLangState(next);
  }, []);

  const t = useCallback(
    (path: TKey, params?: Record<string, string | number>) =>
      interpolate(lookup(DICTS[lang], path), params),
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}

/** Locale code passed to Intl.* APIs. */
export function localeFor(lang: Language): string {
  return lang === "pt" ? "pt-BR" : lang === "es" ? "es-ES" : "en-US";
}
