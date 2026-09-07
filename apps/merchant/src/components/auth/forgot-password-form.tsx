"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, MailCheck, AlertCircle } from "lucide-react";
import { Button, TextField } from "@/components/ui";
import { requestPasswordReset } from "@/lib/actions";

type Alert = { kind: "success" | "error"; text: string };

const SENT_MESSAGE =
  "Password reset email has been sent to your email. Please check your inbox after a few minutes.";
const NOT_FOUND_MESSAGE =
  "This email does not exist in our database. Please check your email address and try again.";

/**
 * The lookup and send both happen in the `requestPasswordReset` server action
 * — the browser can't tell whether an email is registered on its own (and
 * shouldn't be able to). The form only maps the action's outcome onto an
 * alert. It stays on screen after either outcome so a mistyped address can
 * be corrected and resubmitted without navigating back.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState<Alert | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setAlert(null);
    const result = await requestPasswordReset(email);
    setLoading(false);
    if (result.status === "sent") setAlert({ kind: "success", text: SENT_MESSAGE });
    else if (result.status === "not_found") setAlert({ kind: "error", text: NOT_FOUND_MESSAGE });
    else setAlert({ kind: "error", text: result.message });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-ink-950">Forgot your password?</h1>
        <p className="mt-1 text-sm text-ink-500">
          Enter the email on your account and we&apos;ll send you a link to reset it.
        </p>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField id="email" label="Email" type="email" required autoComplete="email" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        {alert && (
          <div
            role="alert"
            className={
              alert.kind === "success"
                ? "flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
                : "flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            }
          >
            {alert.kind === "success" ? (
              <MailCheck className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>{alert.text}</span>
          </div>
        )}
        <Button type="submit" disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send reset link"}
        </Button>
      </form>
      <p className="text-center text-sm text-ink-500">
        <Link href="/login" className="font-semibold text-brand-600 hover:underline">Back to log in</Link>
      </p>
    </div>
  );
}
