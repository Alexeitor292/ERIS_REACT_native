import AppShell from "../ui/AppShell";
import { useUiSettings } from "../ui/UiSettingsContext";

export default function SettingsPage() {
  const { theme, density, mapLayout, setTheme, setDensity, setMapLayout } = useUiSettings();

  return (
    <AppShell title="Settings">
      <div className="p-4 md:p-5 space-y-4">
        <section className="rounded-xl border border-[var(--line)] surface-soft p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Theme</h2>
          <p className="mt-1 text-sm text-muted">Pick the color system for dashboard and detail pages.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              { id: "light", label: "Caltrans Light" },
              { id: "dark", label: "Dark" },
              { id: "coastal", label: "Coastal Teal" },
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => setTheme(opt.id as "light" | "dark" | "coastal")}
                className={`rounded-md border px-3 py-2 text-sm ${
                  theme === opt.id
                    ? "border-[var(--brand)] bg-[var(--brand)] text-white"
                    : "border-[var(--line)] bg-[var(--panel)] hover:brightness-95"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-[var(--line)] surface-soft p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Density</h2>
          <p className="mt-1 text-sm text-muted">Use compact mode for tighter tables and forms.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              { id: "comfortable", label: "Comfortable" },
              { id: "compact", label: "Compact" },
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => setDensity(opt.id as "comfortable" | "compact")}
                className={`rounded-md border px-3 py-2 text-sm ${
                  density === opt.id
                    ? "border-[var(--brand)] bg-[var(--brand)] text-white"
                    : "border-[var(--line)] bg-[var(--panel)] hover:brightness-95"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-[var(--line)] surface-soft p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Map Layout</h2>
          <p className="mt-1 text-sm text-muted">
            Choose how the map appears in submission detail pages.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              { id: "stretched", label: "Stretched (current)" },
              { id: "split", label: "Split (data + map)" },
              { id: "large", label: "Large map" },
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => setMapLayout(opt.id as "stretched" | "split" | "large")}
                className={`rounded-md border px-3 py-2 text-sm ${
                  mapLayout === opt.id
                    ? "border-[var(--brand)] bg-[var(--brand)] text-white"
                    : "border-[var(--line)] bg-[var(--panel)] hover:brightness-95"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
