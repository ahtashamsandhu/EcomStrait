"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { createClient } from "@ecomstrait/auth/client";
import { Button, PasswordField } from "@/components/ui";
import { clearPasswordResetPending } from "@/lib/actions";

export function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "loading">("idle");
  const [error, setError] = useState<string | null>(null);
  // Set instead of guessed from the message text: only "the recovery session
  // is missing" (arriving here without a valid, unused email link) gets the
  // "send a new one" nudge — any other updateUser error is shown as-is.
  const [expired, setExpired] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setStatus("loading");
    setError(null);
    setExpired(false);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      if (error.message === "Auth session missing!") {
        setExpired(true);
        setError("This reset link has expired or was already used.");
      } else {
        setError(error.message);
      }
      setStatus("idle");
      return;
    }
    // Must happen before the redirect below — the middleware guard would
    // otherwise bounce the very next navigation straight back here.
    await clearPasswordResetPending();
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <PasswordField
        id="password"
        label="New password"
        required
        autoComplete="new-password"
        placeholder="At least 8 characters"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <PasswordField
        id="confirm"
        label="Confirm new password"
        required
        autoComplete="new-password"
        placeholder="Re-enter your new password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      {expired && (
        <p className="text-sm text-ink-500">
          <Link href="/forgot-password" className="font-semibold text-brand-600 hover:underline">
            Request a new link
          </Link>
        </p>
      )}
      <Button type="submit" disabled={status === "loading"}>
        {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update password"}
      </Button>
    </form>
  );
}
