import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * The opening animation of the mobile app (mobile/src/ui/AnimatedSplash.tsx),
 * played once after signing in on the web: the logo shrinks into place from
 * six times its size on navy, "ERIS" fades in under it, and the whole screen
 * fades away onto the landing page, which loads underneath meanwhile.
 */
const SplashContext = createContext<() => void>(() => {});

/** Starts the sign-in animation (no-op outside the provider). */
export function useSignInSplash() {
  return useContext(SplashContext);
}

export function SignInSplashProvider({ children }: { children: ReactNode }) {
  const [playing, setPlaying] = useState(0);
  const play = useCallback(() => setPlaying((n) => n + 1), []);
  const value = useMemo(() => play, [play]);
  const done = useCallback(() => setPlaying(0), []);
  return (
    <SplashContext.Provider value={value}>
      {children}
      {playing ? <SignInSplash key={playing} onDone={done} /> : null}
    </SplashContext.Provider>
  );
}

// The mobile timings (shrink 900 ms, "ERIS" from 460 ms, fade out at 1750 ms),
// about half as slow again on the web, with a soft 700 ms fade onto the page.
const FADE_AT_MS = 2700;
const FADE_MS = 700;

function SignInSplash({ onDone }: { onDone: () => void }) {
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const fadeAt = reduced ? 500 : FADE_AT_MS;
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const leave = window.setTimeout(() => setLeaving(true), fadeAt);
    const done = window.setTimeout(onDone, fadeAt + FADE_MS);
    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(done);
    };
  }, [fadeAt, onDone]);

  return (
    <div
      aria-hidden
      className="eris-splash fixed inset-0 z-[100] flex flex-col items-center justify-center"
      style={{ background: "#04132d", opacity: leaving ? 0 : 1, transition: `opacity ${FADE_MS}ms ease-out` }}
    >
      <img src="/eris-splash.png" alt="" className="eris-splash-logo" style={{ width: "min(220px, 54vw)", height: "auto" }} />
      <div className="eris-splash-name mt-3 text-[30px] font-extrabold tracking-[0.08em] text-white">ERIS</div>
    </div>
  );
}
