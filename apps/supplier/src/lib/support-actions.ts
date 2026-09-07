"use server";

import { createClient } from "@ecomstrait/auth/server";
import { escapeHtml } from "@/lib/notify";
import { rateLimit } from "@/lib/rate-limit";

/** Submit a support ticket — emails the team (best-effort). */
export async function submitSupportTicket(input: {
  subject: string;
  message: string;
}): Promise<{ error?: string; ok?: boolean }> {
  const message = String(input?.message ?? "").trim();
  const subject = String(input?.subject ?? "").trim().replace(/[\r\n]+/g, " ");
  if (!message) return { error: "Please describe your issue." };
  if (message.length > 5000) return { error: "Please keep your message under 5,000 characters." };
  if (subject.length > 200) return { error: "Please keep the subject under 200 characters." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Only signed-in suppliers reach the help page; an anonymous caller could
  // otherwise use this to send arbitrary mail to the team from any address.
  if (!user?.email) return { error: "Please sign in to contact support." };
  const limited = await rateLimit(`support:${user.id}`, { limit: 5, windowSeconds: 3600 });
  if (!limited.allowed) return { error: "You've sent several messages recently — we'll reply to those first." };

  const key = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_NOTIFY_EMAIL || process.env.SUPPORT_EMAIL;
  if (!key || !to) {
    // No email configured — accept so the UX isn't blocked in dev.
    return { ok: true };
  }

  const from = process.env.RESEND_FROM || "EcomStrait <onboarding@resend.dev>";
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to,
        reply_to: user.email,
        subject: `Supplier support: ${subject || "(no subject)"}`,
        html: `<p><strong>From:</strong> ${escapeHtml(user.email)}</p><p>${escapeHtml(message)}</p>`,
      }),
    });
  } catch {
    /* best-effort */
  }
  return { ok: true };
}
