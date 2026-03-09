import * as SecureStore from "expo-secure-store";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme as useSystemColorScheme } from "react-native";

type ThemeMode = "system" | "light" | "dark";
type Accent = "blue" | "teal" | "amber";
type Density = "comfortable" | "compact";
type UiScale = 1 | 1.25 | 1.5 | 2 | 4;
type Scheme = "light" | "dark";

type UiSettingsState = {
  themeMode: ThemeMode;
  accent: Accent;
  density: Density;
  uiScale: UiScale;
  textScale: number;
  componentScale: number;
  isAccessibilityLayout: boolean;
  scheme: Scheme;
  palette: {
    bg: string;
    panel: string;
    panelSoft: string;
    border: string;
    text: string;
    muted: string;
    primary: string;
    primaryText: string;
    success: string;
    danger: string;
  };
  setThemeMode: (mode: ThemeMode) => void;
  setAccent: (accent: Accent) => void;
  setDensity: (density: Density) => void;
  setUiScale: (scale: UiScale) => void;
};

const STORAGE_KEY = "eris_ui_settings_v1";

const UiSettingsContext = createContext<UiSettingsState | null>(null);

function getPrimary(accent: Accent): string {
  if (accent === "teal") return "#0d9488";
  if (accent === "amber") return "#d97706";
  return "#1d4ed8";
}

function buildPalette(scheme: Scheme, accent: Accent) {
  const primary = getPrimary(accent);
  if (scheme === "dark") {
    return {
      bg: "#0b1425",
      panel: "#12213a",
      panelSoft: "#172b4a",
      border: "#2a4068",
      text: "#eaf1ff",
      muted: "#a6bddf",
      primary,
      primaryText: "#ffffff",
      success: "#16a34a",
      danger: "#dc2626",
    };
  }
  return {
    bg: "#eef3fb",
    panel: "#ffffff",
    panelSoft: "#f8fbff",
    border: "#d7e2f1",
    text: "#1b2a40",
    muted: "#5c6e8d",
    primary,
    primaryText: "#ffffff",
    success: "#15803d",
    danger: "#b91c1c",
  };
}

export function UiSettingsProvider({ children }: { children: React.ReactNode }) {
  const system = useSystemColorScheme();
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [accent, setAccent] = useState<Accent>("blue");
  const [density, setDensity] = useState<Density>("comfortable");
  const [uiScale, setUiScale] = useState<UiScale>(1);

  useEffect(() => {
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Partial<{ themeMode: ThemeMode; accent: Accent; density: Density; uiScale: UiScale }>;
        if (parsed.themeMode === "system" || parsed.themeMode === "light" || parsed.themeMode === "dark") {
          setThemeMode(parsed.themeMode);
        }
        if (parsed.accent === "blue" || parsed.accent === "teal" || parsed.accent === "amber") {
          setAccent(parsed.accent);
        }
        if (parsed.density === "comfortable" || parsed.density === "compact") {
          setDensity(parsed.density);
        }
        if (parsed.uiScale === 1 || parsed.uiScale === 1.25 || parsed.uiScale === 1.5 || parsed.uiScale === 2 || parsed.uiScale === 4) {
          setUiScale(parsed.uiScale);
        }
      } catch {
        // No-op, defaults apply.
      }
    })();
  }, []);

  useEffect(() => {
    SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify({ themeMode, accent, density, uiScale })).catch(() => {});
  }, [themeMode, accent, density, uiScale]);

  const scheme: Scheme = themeMode === "system" ? (system === "dark" ? "dark" : "light") : themeMode;
  const palette = useMemo(() => buildPalette(scheme, accent), [scheme, accent]);

  const textScale = uiScale;
  const isAccessibilityLayout = uiScale >= 4;
  const componentScale = isAccessibilityLayout ? 2 : uiScale;

  const value = useMemo(
    () => ({
      themeMode,
      accent,
      density,
      uiScale,
      textScale,
      componentScale,
      isAccessibilityLayout,
      scheme,
      palette,
      setThemeMode,
      setAccent,
      setDensity,
      setUiScale,
    }),
    [themeMode, accent, density, uiScale, textScale, componentScale, isAccessibilityLayout, scheme, palette]
  );

  return <UiSettingsContext.Provider value={value}>{children}</UiSettingsContext.Provider>;
}

export function useUiSettings() {
  const ctx = useContext(UiSettingsContext);
  if (!ctx) throw new Error("useUiSettings must be used within UiSettingsProvider");
  return ctx;
}
