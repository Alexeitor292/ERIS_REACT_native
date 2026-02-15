import { createContext, useContext, useEffect, useMemo, useState } from "react";

type ThemeName = "light" | "dark" | "coastal";
type Density = "comfortable" | "compact";

type UiSettings = {
  theme: ThemeName;
  density: Density;
  setTheme: (theme: ThemeName) => void;
  setDensity: (density: Density) => void;
};

const STORAGE_KEY = "eris.ui.settings.v1";

const UiSettingsContext = createContext<UiSettings | null>(null);

function readStoredSettings(): Partial<{ theme: ThemeName; density: Density }> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<{ theme: ThemeName; density: Density }>;
  } catch {
    return {};
  }
}

export function UiSettingsProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>(() => {
    const stored = readStoredSettings().theme;
    return stored === "light" || stored === "dark" || stored === "coastal" ? stored : "light";
  });
  const [density, setDensity] = useState<Density>(() => {
    const stored = readStoredSettings().density;
    return stored === "compact" || stored === "comfortable" ? stored : "comfortable";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-density", density);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, density }));
  }, [theme, density]);

  const value = useMemo(() => ({ theme, density, setTheme, setDensity }), [theme, density]);
  return <UiSettingsContext.Provider value={value}>{children}</UiSettingsContext.Provider>;
}

export function useUiSettings() {
  const ctx = useContext(UiSettingsContext);
  if (!ctx) throw new Error("useUiSettings must be used within UiSettingsProvider");
  return ctx;
}
