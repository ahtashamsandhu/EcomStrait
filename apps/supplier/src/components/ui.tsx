"use client";

import { useState } from "react";
import { Eye, EyeOff, Info } from "lucide-react";
import { cn } from "@ecomstrait/ui";

export function Button({
  className,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost";
}) {
  return (
    <button
      className={cn(
        "inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition disabled:opacity-60",
        variant === "primary" && "bg-brand-500 text-white shadow-lg shadow-brand-500/25 hover:bg-brand-600",
        variant === "outline" && "border border-ink-200 bg-white text-ink-900 hover:bg-ink-50",
        variant === "ghost" && "text-ink-600 hover:bg-ink-100",
        className,
      )}
      {...props}
    />
  );
}

/** Red asterisk shown next to a required field's label. */
export function RequiredMark() {
  return (
    <span className="ml-0.5 text-red-500" aria-hidden>
      *
    </span>
  );
}

/**
 * Small "i" icon that reveals a short explanation on hover or keyboard focus.
 * Pure CSS (group-hover / focus-within) — no positioning library needed for a
 * one-line hint next to a form label.
 */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative ml-1.5 inline-flex align-middle">
      <button
        type="button"
        aria-label={text}
        className="grid h-4 w-4 place-items-center rounded-full text-ink-400 transition hover:text-ink-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-60 -translate-x-1/2 rounded-lg bg-ink-950 px-3 py-2 text-xs font-normal leading-snug text-white opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

export function TextField({
  label,
  id,
  hint,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  id: string;
  /** Shown as an info tooltip next to the label. */
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink-700">
        {label}
        {props.required && <RequiredMark />}
        {hint && <InfoTip text={hint} />}
      </label>
      <input
        id={id}
        className={cn(
          "h-11 rounded-xl border border-ink-200 bg-white px-4 text-sm text-ink-950 outline-none transition placeholder:text-ink-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20",
          className,
        )}
        {...props}
      />
    </div>
  );
}

/** Same as TextField, but for `type="password"` — adds a show/hide toggle. */
export function PasswordField({
  label,
  id,
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string; id: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink-700">
        {label}
        {props.required && <RequiredMark />}
      </label>
      <div className="relative">
        <input
          id={id}
          type={shown ? "text" : "password"}
          className={cn(
            "h-11 w-full rounded-xl border border-ink-200 bg-white py-2.5 pl-4 pr-11 text-sm text-ink-950 outline-none transition placeholder:text-ink-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20",
            className,
          )}
          {...props}
        />
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          tabIndex={-1}
          aria-label={shown ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 grid w-11 place-items-center text-ink-400 hover:text-ink-600"
        >
          {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
