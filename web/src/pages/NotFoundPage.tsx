import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";

export default function NotFoundPage() {
  const { token } = useAuth();

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-8 text-[var(--ink)] sm:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl items-center justify-center">
        <section className="w-full rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6 text-center shadow-[var(--shadow)] sm:p-10">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--brand)] text-sm font-bold tracking-wide text-white">ERIS</div>
          <div className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-muted">Page not found</div>
          <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">This ERIS location does not exist.</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted">
            The address may be outdated, incomplete, or no longer available. Return to a known ERIS workspace instead of retrying the same URL.
          </p>

          <div className="mt-7 flex flex-wrap justify-center gap-2">
            <Link to={token ? "/mission-center" : "/login"} className="rounded-md bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-95">
              {token ? "Go to Mission Center" : "Go to sign in"}
            </Link>
            {token ? (
              <Link to="/submissions" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--panel-soft)]">
                Open submissions
              </Link>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
