import AppShell from "../ui/AppShell";
import { useUiSettings } from "../ui/UiSettingsContext";

const THEMES = [
  {
    id: "light" as const,
    label: "Caltrans Light",
    description: "High-contrast light workspace for normal office use.",
  },
  {
    id: "dark" as const,
    label: "Dark",
    description: "Reduced-glare dark workspace for low-light environments.",
  },
  {
    id: "coastal" as const,
    label: "Coastal Teal",
    description: "Alternative light palette with teal emphasis.",
  },
];

export default function SettingsPage() {
  const { theme, setTheme } = useUiSettings();

  return (
    <AppShell title="Settings">
      <div className="space-y-4 p-4 md:p-5">
        <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
          <div className="max-w-2xl">
            <h2 className="text-base font-semibold">Appearance</h2>
            <p className="mt-1 text-sm text-muted">
              Choose the color palette used across ERIS. This preference is stored in this browser and takes effect immediately.
            </p>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {THEMES.map((option) => {
              const selected = theme === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setTheme(option.id)}
                  aria-pressed={selected}
                  className={`rounded-xl border p-4 text-left transition-[border-color,background-color,box-shadow] ${
                    selected
                      ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))] shadow-[0_0_0_1px_color-mix(in_oklab,var(--brand)_22%,transparent)]"
                      : "border-[var(--line)] bg-[var(--panel-soft)] hover:border-[color:color-mix(in_oklab,var(--brand)_42%,var(--line))]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold">{option.label}</span>
                    <span
                      aria-hidden
                      className={`h-3 w-3 rounded-full border ${selected ? "border-[var(--brand)] bg-[var(--brand)]" : "border-[var(--line)] bg-[var(--panel)]"}`}
                    />
                  </div>
                  <div className="mt-2 text-sm text-muted">{option.description}</div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4">
          <h2 className="text-sm font-semibold">About these settings</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            ERIS only exposes preferences here when they are implemented throughout the application. Workflow, permissions, review rules, and server-managed configuration are not changed from this page.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
