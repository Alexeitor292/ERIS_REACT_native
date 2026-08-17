import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    return element.getClientRects().length > 0;
  });
}

export default function ModalDialog({
  titleId,
  descriptionId,
  children,
  onClose,
  busy = false,
  overlayClassName = "fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4",
  panelClassName = "w-full max-w-xl rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5 shadow-2xl",
}: {
  titleId: string;
  descriptionId?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  overlayClassName?: string;
  panelClassName?: string;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);

  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusInitialControl = () => {
      if (!dialog) return;
      const explicit = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus="true"]');
      const target = explicit ?? focusableElements(dialog)[0] ?? dialog;
      target.focus({ preventScroll: true });
    };

    const frame = window.requestAnimationFrame(focusInitialControl);

    const onKeyDown = (event: KeyboardEvent) => {
      const root = dialogRef.current;
      if (!root) return;

      if (event.key === "Escape") {
        if (!busyRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = focusableElements(root);
      if (focusable.length === 0) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }

      const active = document.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!root.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  function onBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !busyRef.current) onCloseRef.current();
  }

  return (
    <div className={overlayClassName} role="presentation" onMouseDown={onBackdropMouseDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={panelClassName}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
