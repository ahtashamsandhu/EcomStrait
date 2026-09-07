"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { createClient } from "@ecomstrait/auth/client";
import { Button, PasswordField } from "@/components/ui";

/**
 * Change (or, for a Google-only account, set for the first time) the
 * account's password. `hasPassword` decides which form shows — Supabase
 * links an "email" identity onto an OAuth account automatically the moment
 * `updateUser({ password })` succeeds, so setting one here is also what
 * turns on email+password login for a Google sign-in.
 */
export function PasswordCard({ email, hasPassword: initialHasPassword }: { email: string; hasPassword: boolean }) {
  const router = useRouter();
  const [hasPassword, setHasPassword] = useState(initialHasPassword);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "loading">("idle");
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setStatus("loading");
    const supabase = createClient();

    if (hasPassword) {
      const { error: verifyErr } = await supabase.auth.signInWithPassword({ email, password: current });
      if (verifyErr) {
        setError("Current password is incorrect.");
        setStatus("idle");
        return;
      }
    }

    const { error: updateErr } = await supabase.auth.updateUser({ password: next });
    setStatus("idle");
    if (updateErr) {
      setError(updateErr.message);
      return;
    }
    setCurrent("");
    setNext("");
    setConfirm("");
    setHasPassword(true);
    setJustSaved(true);
    router.refresh();
    setTimeout(() => setJustSaved(false), 1500);
  }

  return (
    <section className="rounded-2xl border border-ink-100 bg-white p-5">
      <h2 className="text-sm font-semibold text-ink-950">Password</h2>
      {!hasPassword && (
        <p className="mt-1 text-xs text-ink-500">
          You signed in with Google — set a password to also be able to log in with your email.
        </p>
      )}
      <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-4">
        {hasPassword && (
          <PasswordField
            id="currentPassword"
            label="Current password"
            required
            autoComplete="current-password"
            placeholder="Enter your current password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        )}
        <PasswordField
          id="newPassword"
          label="New password"
          required
          autoComplete="new-password"
          placeholder="At least 8 characters"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <PasswordField
          id="confirmPassword"
          label="Confirm new password"
          required
          autoComplete="new-password"
          placeholder="Re-enter your new password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end">
          <Button type="submit" disabled={status === "loading"} className="h-9 w-auto px-4">
            {status === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : justSaved ? (
              <>
                <Check className="h-3.5 w-3.5" /> Saved
              </>
            ) : hasPassword ? (
              "Update password"
            ) : (
              "Set password"
            )}
          </Button>
        </div>
      </form>
    </section>
  );
}
