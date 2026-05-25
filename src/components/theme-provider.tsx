import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/** A user-selectable theme. `system` follows the OS preference. */
export type Theme = "light" | "dark" | "system";

/** The concrete theme actually applied to the DOM (never `system`). */
export type ResolvedTheme = "light" | "dark";

/** Color palettes selectable in Appearance settings. */
export type ColorTheme =
  | "purple"
  | "blue"
  | "red"
  | "pink"
  | "green"
  | "orange"
  | "yellow";

export const COLOR_THEMES: ColorTheme[] = [
  "purple",
  "blue",
  "red",
  "pink",
  "green",
  "orange",
  "yellow",
];

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  colorTheme: ColorTheme;
  setColorTheme: (color: ColorTheme) => void;
};

const STORAGE_KEY = "postgly-theme";
const COLOR_STORAGE_KEY = "postgly-color";

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readStoredColor(): ColorTheme {
  const raw = localStorage.getItem(COLOR_STORAGE_KEY) as ColorTheme | null;
  return raw && COLOR_THEMES.includes(raw) ? raw : "purple";
}

/**
 * Provides theme state and persists the user's choice to localStorage.
 * Applies the resolved theme as a `.dark`/`.light` class on <html> so the
 * CSS tokens in index.css switch palettes.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system",
  );
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(readStoredColor);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);

  // Track OS preference changes while the app is open.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemTheme(getSystemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: ResolvedTheme =
    theme === "system" ? systemTheme : theme;

  // Reflect the resolved theme onto <html>.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
  }, [resolvedTheme]);

  // Reflect color palette onto <html data-color="...">. CSS overrides
  // in index.css remap --primary / --ring / --grad-* per selection.
  useEffect(() => {
    document.documentElement.dataset.color = colorTheme;
  }, [colorTheme]);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const setColorTheme = useCallback((next: ColorTheme) => {
    localStorage.setItem(COLOR_STORAGE_KEY, next);
    setColorThemeState(next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, colorTheme, setColorTheme }),
    [theme, resolvedTheme, setTheme, colorTheme, setColorTheme],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

/** Access theme state. Must be used inside a `<ThemeProvider>`. */
export function useTheme() {
  const ctx = useContext(ThemeProviderContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
