import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

type BoundaryProps = { resetKey: string; children: ReactNode };
type BoundaryState = { error: Error | null };

/**
 * Catches a render or effect error anywhere in the routed app. Without it,
 * React unmounts the whole tree and leaves a blank page until a reload. The
 * boundary clears itself on the next navigation.
 */
class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ERIS page error", error, info.componentStack);
  }

  componentDidUpdate(prevProps: BoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] p-6">
        <div className="max-w-md rounded-xl border border-[var(--line)] bg-[var(--panel)] p-6 text-center">
          <h1 className="text-lg font-semibold">This page could not be shown</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Something went wrong while loading it. Reloading usually fixes it; nothing you saved is lost.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
            >
              Reload page
            </button>
            <a href="/" className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm font-medium">
              Go to start
            </a>
          </div>
        </div>
      </div>
    );
  }
}

export default function AppErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <Boundary resetKey={location.pathname}>{children}</Boundary>;
}
