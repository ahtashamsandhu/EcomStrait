"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createClient } from "@ecomstrait/auth/client";
import { Button, TextField, PasswordField } from "@/components/ui";
import { authCallbackUrl } from "@/lib/site-url";
import { checkEmailAvailability } from "@/lib/actions";

const OTHER_APP = "merchant";
const TAKEN_MESSAGE =
  `An account with this email already exists. Each email can hold one EcomStrait account, ` +
  `whether it was created here or in the ${OTHER_APP} app — log in instead, or use a different email.`;

export function SignupForm() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "loading">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setStatus("loading");
    setError(null);
    // Supabase's signUp deliberately looks successful for an address that
    // already exists, so ask the server first and say so plainly.
    const availability = await checkEmailAvailability(email);
    if (availability.status !== "available") {
      setError(availability.status === "taken" ? TAKEN_MESSAGE : availability.message);
      setStatus("idle");
      return;
    }
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: authCallbackUrl(),
      },
    });
    if (error) {
      setError(error.message);
      setStatus("idle");
      return;
    }
    // Belt and braces: with confirmations on, an existing address comes back
    // as a user with no identities rather than an error.
    if (data.user && (data.user.identities ?? []).length === 0) {
      setError(TAKEN_MESSAGE);
      setStatus("idle");
      return;
    }
    // Session present → email confirmation is disabled → straight in.
    // No session → confirmation email sent → go wait for it.
    if (data.session) {
      router.push("/dashboard");
      router.refresh();
    } else {
      router.push(`/verify-email?email=${encodeURIComponent(email)}`);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        id="fullName"
        label="Full name"
        required
        autoComplete="name"
        placeholder="Jane Doe"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
      />
      <TextField
        id="email"
        label="Email"
        type="email"
        required
        autoComplete="email"
        placeholder="you@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <PasswordField
        id="password"
        label="Password"
        required
        autoComplete="new-password"
        placeholder="At least 8 characters"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={status === "loading"}>
        {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create account"}
      </Button>
    </form>
  );
}
