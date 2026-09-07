import type { Metadata } from "next";
import { TrendingUp, DollarSign, ShoppingBag, Package, Receipt, Clock, HandCoins } from "lucide-react";
import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import { getMerchantRevenueAnalytics } from "@/lib/revenue-analytics";

export const metadata: Metadata = { title: "Sales" };

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function SalesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: stores } = await supabase
    .from("stores")
    .select("id, name")
    .eq("user_id", user!.id);
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name ?? "—"]));
  const storeIds = (stores ?? []).map((s) => s.id);

  const admin = createAdminClient();
  const a = await getMerchantRevenueAnalytics(supabase, admin, user!.id, storeIds, storeName);

  const metrics = [
    {
      label: "Revenue",
      value: money(a.netRevenue),
      sub: "Realized — after supplier cost & platform fee",
      icon: DollarSign,
    },
    { label: "Gross sales", value: money(a.grossSales), sub: "Total checkout value, all orders", icon: TrendingUp },
    { label: "Orders", value: String(a.orderCount), icon: ShoppingBag },
    { label: "Avg. order", value: money(a.avgOrder), icon: Receipt },
    { label: "Units sold", value: String(a.units), icon: Package },
    {
      label: "Pending payout",
      value: money(a.pendingPayout),
      sub: "Owed by EcomStrait, next settlement",
      icon: HandCoins,
    },
  ];

  const maxDay = Math.max(1, ...a.revenueByDay.map((d) => d.total));
  const empty = a.orderCount === 0;

  return (
    <div className="mx-auto max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-ink-950">Sales</h1>
        <p className="mt-1 text-sm text-ink-500">Revenue and performance across your stores.</p>
      </div>

      {a.heldCount > 0 && (
        <div className="mt-6 flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-800">
          <Clock className="h-4 w-4 shrink-0" />
          <span>
            {a.heldCount} order{a.heldCount === 1 ? "" : "s"} worth {money(a.heldValue)} {a.heldCount === 1 ? "is" : "are"}{" "}
            on hold, waiting on your wallet balance — not counted in Revenue yet. See{" "}
            <a href="/wallet" className="font-semibold underline">
              Wallet
            </a>
            .
          </span>
        </div>
      )}

      {empty ? (
        <div className="mt-6 grid place-items-center rounded-2xl border border-dashed border-ink-200 bg-white p-12 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-ink-100 text-ink-400">
            <TrendingUp className="h-7 w-7" />
          </span>
          <p className="mt-4 max-w-sm text-sm text-ink-500">
            No sales yet. Once customers start buying, your revenue and top products show up here.
          </p>
        </div>
      ) : (
        <>
          {/* Metric cards */}
          <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
            {metrics.map((m) => (
              <div key={m.label} className="rounded-2xl border border-ink-100 bg-white p-4">
                <div className="flex items-center gap-2 text-ink-400">
                  <m.icon className="h-4 w-4" />
                  <span className="text-xs font-medium">{m.label}</span>
                </div>
                <p className="mt-2 text-2xl font-bold text-ink-950">{m.value}</p>
                {m.sub && <p className="mt-0.5 text-[11px] text-ink-400">{m.sub}</p>}
              </div>
            ))}
          </div>

          {/* 14-day gross sales chart */}
          <div className="mt-6 rounded-2xl border border-ink-100 bg-white p-5">
            <p className="text-sm font-semibold text-ink-900">Gross sales · last 14 days</p>
            <div className="mt-5 flex h-40 items-end gap-1.5">
              {a.revenueByDay.map((d) => (
                <div key={d.label} className="group flex flex-1 flex-col items-center gap-1">
                  <div className="relative flex w-full flex-1 items-end">
                    <div
                      className="w-full rounded-t bg-brand-400 transition-all group-hover:bg-brand-500"
                      style={{ height: `${Math.max(2, (d.total / maxDay) * 100)}%` }}
                      title={`${d.label}: ${money(d.total)}`}
                    />
                  </div>
                  <span className="text-[9px] text-ink-400">{d.label.split(" ")[1]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 grid gap-6 md:grid-cols-2">
            {/* Gross sales by store */}
            <div className="rounded-2xl border border-ink-100 bg-white p-5">
              <p className="text-sm font-semibold text-ink-900">Gross sales by store</p>
              <div className="mt-4 space-y-3">
                {a.revenueByStore.map((s) => (
                  <div key={s.name}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-ink-700">{s.name}</span>
                      <span className="font-semibold text-ink-900">{money(s.total)}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-100">
                      <div
                        className="h-full rounded-full bg-brand-400"
                        style={{ width: `${(s.total / (a.revenueByStore[0]?.total || 1)) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Top products */}
            <div className="rounded-2xl border border-ink-100 bg-white p-5">
              <p className="text-sm font-semibold text-ink-900">Top products</p>
              <div className="mt-4 space-y-3">
                {a.topProducts.map((p) => (
                  <div key={p.name} className="flex items-center justify-between text-sm">
                    <span className="max-w-[60%] truncate text-ink-700" title={p.name}>
                      {p.name}
                    </span>
                    <span className="text-ink-400">
                      {p.units} sold · <span className="font-semibold text-ink-900">{money(p.revenue)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
