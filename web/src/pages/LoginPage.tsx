import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import AuthGateLoading from "../auth/AuthGateLoading";
import { useAuth } from "../auth/AuthContext";
import { hasMaintenanceDuties, landingPathFor } from "../utils/roleModel";
import { useSignInSplash } from "../ui/SignInSplash";
import { appConfig } from "../config";
import { api } from "../api/client";
import { shouldStartSingleSignOn } from "./loginModel";

type SignInMethods = { local_login_enabled: boolean; entra_enabled: boolean };

// Fixed reasons the API's Entra callback sends back; never Entra's own text.
const ENTRA_NOTICES: Record<string, string> = {
  cancelled: "Caltrans sign-in was not completed. Try again when ready.",
  failed: "Caltrans sign-in could not be verified. Try again; if it keeps failing, contact the ERIS administrator.",
  not_linked: "Your Caltrans account is not linked to an active ERIS account. Ask an ERIS administrator for access.",
  unavailable: "Caltrans sign-in is not available right now. Contact the ERIS administrator.",
};

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, signedIn, me, isInitializing } = useAuth();
  const playSplash = useSignInSplash();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The API decides which sign-in methods exist, so turning password sign-in
  // off after handover needs no web rebuild. Until it answers (or if it cannot),
  // the build-time settings stand.
  const [methods, setMethods] = useState<SignInMethods>({
    local_login_enabled: appConfig.localLoginEnabled,
    entra_enabled: appConfig.entraEnabled,
  });
  const [methodsKnown, setMethodsKnown] = useState(false);
  // Read once on arrival: why this page is showing, if it was sent here.
  const [arrival] = useState(() => {
    const entraReason = new URLSearchParams(window.location.search).get("entra");
    let signedOut = false;
    let expired = false;
    try {
      signedOut = sessionStorage.getItem("eris_signed_out") === "1";
      expired = sessionStorage.getItem("eris_session_expired") === "1";
      sessionStorage.removeItem("eris_signed_out");
      sessionStorage.removeItem("eris_session_expired");
    } catch {
      // Browser storage may be unavailable under hardened/private policies.
    }
    return { entraReason, signedOut, expired };
  });
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<SignInMethods>("/auth/config")
      .then((live) => {
        if (!cancelled) setMethods({ local_login_enabled: !!live.local_login_enabled, entra_enabled: !!live.entra_enabled });
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setMethodsKnown(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (arrival.entraReason) {
      setNotice(ENTRA_NOTICES[arrival.entraReason] ?? ENTRA_NOTICES.failed);
      window.history.replaceState(null, "", "/login");
    } else if (arrival.signedOut) {
      setNotice("You have signed out of ERIS.");
    } else if (arrival.expired) {
      setNotice("Your ERIS session expired. Sign in again to continue.");
    }
  }, [arrival]);

  // Caltrans SSO-only deployments go straight to Entra, like other Caltrans
  // web apps: on a managed Windows device Entra usually signs the person in
  // with their dot.ca.gov account and applies MFA and Conditional Access.
  const autoStart = shouldStartSingleSignOn({
    methodsKnown,
    entraEnabled: methods.entra_enabled,
    localLoginEnabled: methods.local_login_enabled,
    signedIn,
    isInitializing,
    entraReason: arrival.entraReason,
    signedOut: arrival.signedOut,
  });
  useEffect(() => {
    if (!autoStart) return;
    setRedirecting(true);
    window.location.assign(`${appConfig.apiBaseUrl}/auth/entra/start`);
  }, [autoStart]);

  if (isInitializing || redirecting) return <AuthGateLoading />;
  // Signed in already: on to this person's own landing.
  if (signedIn && me) return <Navigate to={landingPathFor(me.roles, hasMaintenanceDuties(me))} replace />;

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
      const account = await login(normalizedEmail, password);
      // The mobile app's opening animation, over the landing page as it loads.
      playSplash();
      navigate(landingPathFor(account.roles, hasMaintenanceDuties(account)), { replace: true });
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

              {methods.entra_enabled ? <a href={`${appConfig.apiBaseUrl}/auth/entra/start`} className="mt-6 block rounded-md bg-[var(--brand)] px-4 py-2.5 text-center text-sm font-semibold text-white hover:brightness-95">Sign in with Caltrans Microsoft Entra</a> : null}
              {methods.local_login_enabled ? <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
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
              </form> : null}

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
