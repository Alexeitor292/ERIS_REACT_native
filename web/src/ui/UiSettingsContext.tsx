import { createContext, useContext, useEffect, useMemo, useState } from "react";

type ThemeName = "light" | "dark" | "coastal";

type StoredSettings = { theme: ThemeName; navCollapsed: boolean; pageTransitions: boolean };

type UiSettings = StoredSettings & {
  setTheme: (theme: ThemeName) => void;
  /** The side navigation, collapsed to icons; kept across pages and visits. */
  setNavCollapsed: (collapsed: boolean) => void;
  /** Pages slide into place when the side navigation changes page. */
  setPageTransitions: (on: boolean) => void;
};

const STORAGE_KEY = "eris.ui.settings.v1";

const UiSettingsContext = createContext<UiSettings | null>(null);

function readStoredSettings(): Partial<StoredSettings> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<StoredSettings>;
  } catch {
    return {};
  }
}

export function UiSettingsProvider({ children }: { children: React.ReactNode }) {
  const [stored] = useState(readStoredSettings);
  const [theme, setTheme] = useState<ThemeName>(() =>
    stored.theme === "light" || stored.theme === "dark" || stored.theme === "coastal" ? stored.theme : "light"
  );
  const [navCollapsed, setNavCollapsed] = useState(stored.navCollapsed === true);
  const [pageTransitions, setPageTransitions] = useState(stored.pageTransitions !== false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.removeAttribute("data-density");
    document.documentElement.setAttribute("data-page-transitions", pageTransitions ? "on" : "off");
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, navCollapsed, pageTransitions }));
    } catch {
      // Preferences are a convenience; without storage they last until the page closes.
    }
  }, [theme, navCollapsed, pageTransitions]);

  const value = useMemo(
    () => ({ theme, setTheme, navCollapsed, setNavCollapsed, pageTransitions, setPageTransitions }),
    [theme, navCollapsed, pageTransitions]
  );
  return <UiSettingsContext.Provider value={value}>{children}</UiSettingsContext.Provider>;
}

export function useUiSettings() {
  const ctx = useContext(UiSettingsContext);
  if (!ctx) throw new Error("useUiSettings must be used within UiSettingsProvider");
  return ctx;
}
