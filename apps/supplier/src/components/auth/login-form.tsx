"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { createClient } from "@ecomstrait/auth/client";
import { Button, TextField, PasswordField } from "@/components/ui";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get("redirect") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "loading">("idle");
  // Seeded from /auth/callback or /auth/confirm's `?error=auth` fallback —
  // without this, a failed reset/confirmation link just silently lands here
  // with no explanation of what happened.
  const [error, setError] = useState<string | null>(
    params.get("error") === "auth"
      ? "That link didn't work — it may have expired, already been used, or been opened somewhere other than where you requested it. Request a new one below."
      : null,
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setStatus("idle");
      return;
    }
    router.push(redirectTo);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        id="email"
        label="Email"
        type="email"
        required
        autoComplete="email"
        placeholder="you@business.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <PasswordField
        id="password"
        label="Password"
        required
        autoComplete="current-password"
        placeholder="Enter your password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Link href="/forgot-password" className="-mt-2 self-end text-xs font-semibold text-brand-600 hover:underline">
        Forgot password?
      </Link>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={status === "loading"}>
        {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Log in"}
      </Button>
    </form>
  );
}
