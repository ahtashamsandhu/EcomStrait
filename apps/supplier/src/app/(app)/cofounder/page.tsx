import type { Metadata } from "next";
import { createClient } from "@ecomstrait/auth/server";
import { loadChatThread } from "@ecomstrait/ai";
import { getMySupplier } from "@/lib/supplier-context";
import { PendingGate } from "@/components/app/pending-gate";
import { getEntitlements } from "@/lib/entitlements";
import { CoFounderChat } from "@/components/cofounder/cofounder-chat";

export const metadata: Metadata = { title: "EcomAI Co-Founder" };

export default async function CoFounderPage() {
  const supabase = await createClient();
  const my = await getMySupplier();

  const { data: supplier } = my
    ? await supabase.from("suppliers").select("status, business_name").eq("id", my.supplierId).maybeSingle()
    : { data: null };

  if (!supplier || supplier.status !== "approved") {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold text-ink-950">EcomAI Co-Founder</h1>
        <p className="mt-1 text-sm text-ink-500">Chat with your AI advisor about your business.</p>
        <div className="mt-6">
          <PendingGate status={supplier?.status ?? null} feature="the AI Co-Founder" />
        </div>
      </div>
    );
  }

  // `supplier` (checked above) only ever resolved via the `my` branch, so
  // `my` is guaranteed here — captured once to avoid repeating `my!`.
  const supplierId = my!.supplierId;
  const [e, thread] = await Promise.all([
    getEntitlements(),
    // One thread per supplier business, not per staff account — anyone on
    // the team who opens this chat continues the same conversation.
    loadChatThread({ tenantId: supplierId, agent: "supplier_cofounder", threadKey: supplierId }),
  ]);

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-ink-950">EcomAI Co-Founder</h1>
          <p className="mt-1 text-sm text-ink-500">
            Grounded in your real revenue, orders, catalog, and quality data — ask about growth, pricing,
            fulfilment, or what to fix first.
          </p>
        </div>
      </div>
      <CoFounderChat
        businessName={supplier.business_name}
        initialMessages={thread.messages}
        initialTokensRemaining={e.tokensRemaining}
      />
    </div>
  );
}
