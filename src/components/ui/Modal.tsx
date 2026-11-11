"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
  open,
  onClose,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(t);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="animate-pop w-full max-w-[320px] rounded-2xl bg-canvas p-8 shadow-pop"
      >
        {children}
      </div>
    </div>
  );
}

/** X-style confirmation dialog: title, body, primary + cancel stacked buttons. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={busy ? () => {} : onCancel} labelledBy="confirm-title">
      <h2 id="confirm-title" className="text-xl font-bold leading-6 text-ink">
        {title}
      </h2>
      {body && <div className="mt-2 text-[15px] leading-5 text-muted">{body}</div>}
      {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="mt-6 flex flex-col gap-3">
        <button
          data-autofocus
          disabled={busy}
          onClick={onConfirm}
          className={`h-11 rounded-full text-[15px] font-bold text-white transition-colors disabled:opacity-60 ${
            danger ? "bg-danger hover:bg-[#dc1e29]" : "bg-ink !text-canvas hover:opacity-90"
          }`}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
        <button
          disabled={busy}
          onClick={onCancel}
          className="h-11 rounded-full border border-line-strong text-[15px] font-bold text-ink transition-colors hover:bg-hover disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}
