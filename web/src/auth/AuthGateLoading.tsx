export default function AuthGateLoading() {
  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-8 text-[var(--ink)]">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-lg items-center justify-center">
        <section className="w-full rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6 text-center shadow-[var(--shadow)]">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--brand)] text-xs font-bold tracking-wide text-white">ERIS</div>
          <div className="mt-5 text-sm font-semibold">Validating ERIS session</div>
          <div className="mt-2 text-sm text-muted">Confirming your account and access before loading operational data.</div>
          <div className="mx-auto mt-5 h-1.5 max-w-48 overflow-hidden rounded-full bg-[var(--panel-soft)]">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-[var(--brand)]" />
          </div>
        </section>
      </div>
    </main>
  );
}
