import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@ecomstrait/auth/server";
import { loadChatThread } from "@ecomstrait/ai";
import { getEntitlements } from "@/lib/entitlements";
import { CoFounderChat } from "@/components/cofounder/cofounder-chat";

export const metadata: Metadata = { title: "EcomAI Co-Founder" };

export default async function CoFounderPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, e, thread] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("user_id", user.id).maybeSingle(),
    getEntitlements(),
    // One thread per merchant (their whole portfolio, not one per store) —
    // see Docs/prompts/merchant-cofounder-chat.md for why this chat reasons
    // across stores rather than about just one.
    loadChatThread({ tenantId: user.id, agent: "merchant_cofounder", threadKey: user.id }),
  ]);

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-ink-950">EcomAI Co-Founder</h1>
          <p className="mt-1 text-sm text-ink-500">
            Grounded in your real stores, revenue, orders, and wallet balance — ask about growth,
            what to fix first, or how you&apos;re doing.
          </p>
        </div>
      </div>
      <CoFounderChat
        businessName={profile?.full_name ?? null}
        initialMessages={thread.messages}
        initialTokensRemaining={e.tokensRemaining}
      />
    </div>
  );
}
