import { createContext, useContext, useEffect, useMemo, useState } from "react";

type ThemeName = "light" | "dark" | "coastal";

type UiSettings = {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
};

const STORAGE_KEY = "eris.ui.settings.v1";

const UiSettingsContext = createContext<UiSettings | null>(null);

function readStoredSettings(): Partial<{ theme: ThemeName }> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<{ theme: ThemeName }>;
  } catch {
    return {};
  }
}

export function UiSettingsProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>(() => {
    const stored = readStoredSettings().theme;
    return stored === "light" || stored === "dark" || stored === "coastal" ? stored : "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.removeAttribute("data-density");
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme }));
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme }), [theme]);
  return <UiSettingsContext.Provider value={value}>{children}</UiSettingsContext.Provider>;
}

export function useUiSettings() {
  const ctx = useContext(UiSettingsContext);
  if (!ctx) throw new Error("useUiSettings must be used within UiSettingsProvider");
  return ctx;
}
