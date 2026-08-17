import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import AuthGateLoading from "../auth/AuthGateLoading";
import { useAuth } from "../auth/AuthContext";

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, token, isInitializing } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("eris_session_expired") === "1") {
        setNotice("Your ERIS session expired. Sign in again to continue.");
        sessionStorage.removeItem("eris_session_expired");
      }
    } catch {
      // Browser storage may be unavailable under hardened/private policies.
    }
  }, []);

  if (isInitializing && token) return <AuthGateLoading />;
  if (!isInitializing && token) return <Navigate to="/mission-center" replace />;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setError("Enter your ERIS email and password.");
      return;
    }

    setBusy(true);
    try {
      await login(normalizedEmail, password);
      navigate("/mission-center", { replace: true });
    } catch (e: any) {
      setError(e?.message ?? "Sign in failed. Verify your credentials and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-8 text-[var(--ink)] sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-6xl items-center justify-center">
        <div className="grid w-full overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)] lg:grid-cols-[1.15fr_0.85fr]">
          <section className="hidden min-h-[620px] flex-col justify-between border-r border-[var(--line)] bg-[var(--panel-soft)] p-10 lg:flex">
            <div>
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--brand)] text-sm font-bold tracking-wide text-white">
                ERIS
              </div>
              <div className="mt-8 max-w-xl">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand)]">Caltrans · Geotechnical Services</div>
                <h1 className="mt-3 text-4xl font-semibold leading-tight">Emergency Response Information System</h1>
                <p className="mt-4 max-w-lg text-base leading-7 text-muted">
                  Secure access to emergency incidents, field submissions, geotechnical assessments, mapped evidence, and operational review workflows.
                </p>
              </div>
            </div>

            <div className="grid gap-3 text-sm text-muted">
              <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
                <div className="font-semibold text-[var(--ink)]">Internal Caltrans system</div>
                <div className="mt-1">Access is limited to authorized ERIS users and governed by assigned application roles.</div>
              </div>
              <div className="text-xs">Emergency Response Information System · Internal use</div>
            </div>
          </section>

          <section className="flex min-h-[620px] items-center p-6 sm:p-10">
            <div className="mx-auto w-full max-w-md">
              <div className="lg:hidden">
                <div className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--brand)] text-xs font-bold tracking-wide text-white">ERIS</div>
                <div className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand)]">Caltrans · Geotechnical Services</div>
              </div>

              <div className="mt-6 lg:mt-0">
                <h2 className="text-2xl font-semibold">Sign in to ERIS</h2>
                <p className="mt-2 text-sm leading-6 text-muted">Use your authorized ERIS account to continue.</p>
              </div>

              {notice ? (
                <div className="mt-5 rounded-lg border border-[color:color-mix(in_oklab,var(--brand)_35%,var(--line))] bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] px-3 py-2.5 text-sm">
                  {notice}
                </div>
              ) : null}

              {error ? (
                <div className="mt-5 rounded-lg border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2.5 text-sm text-[var(--bad)]">
                  {error}
                </div>
              ) : null}

              <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
                <label className="grid gap-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">Email</span>
                  <input
                    type="email"
                    autoComplete="username"
                    inputMode="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={busy}
                    className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2.5 text-sm outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[color:color-mix(in_oklab,var(--brand)_25%,transparent)] disabled:opacity-60"
                    placeholder="name@dot.ca.gov"
                  />
                </label>

                <label className="grid gap-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">Password</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy}
                    className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2.5 text-sm outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[color:color-mix(in_oklab,var(--brand)_25%,transparent)] disabled:opacity-60"
                  />
                </label>

                <button type="submit" disabled={busy} className="mt-2 rounded-md bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60">
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>

              <div className="mt-6 border-t border-[var(--line)] pt-4 text-xs leading-5 text-muted">
                If you cannot access ERIS, contact your application administrator. Do not share credentials or create duplicate accounts.
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
