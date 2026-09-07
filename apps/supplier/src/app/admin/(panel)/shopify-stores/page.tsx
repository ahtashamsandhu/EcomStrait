import type { Metadata } from "next";
import { createAdminClient } from "@ecomstrait/db/admin";
import { PROMO_USER_LIMIT } from "@ecomstrait/db";
import type { ShopifyStoreStatus } from "@ecomstrait/db/types";
import { StorefrontPasswordField } from "@/components/admin/storefront-password-field";
import { TransferControl } from "@/components/admin/transfer-control";
import { SearchBar } from "@/components/app/search-bar";
import { Pagination } from "@/components/app/pagination";
import { clampPage, likeTerm, parseTableParams, type RawParams } from "@/lib/table-params";

export const metadata: Metadata = { title: "Shopify stores — Admin" };

const STATUS_STYLE: Record<ShopifyStoreStatus, string> = {
  available: "bg-brand-50 text-brand-700",
  assigned: "bg-ai-50 text-ai-700",
  building: "bg-ai-50 text-ai-700",
  ready_for_review: "bg-amber-50 text-amber-700",
  client_approved: "bg-brand-50 text-brand-700",
  waiting_for_transfer: "bg-amber-50 text-amber-700",
  transferred: "bg-ink-100 text-ink-500",
  archived: "bg-ink-100 text-ink-400",
};

export default async function AdminShopifyStoresPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;
  const { q, page: wanted, size } = parseTableParams(params);

  const client = createAdminClient();
  if (!client) return <p className="text-sm text-red-600">Server is not configured.</p>;

  const storeQuery = () => {
    let query = client
      .from("shopify_stores")
      .select("id, shop_domain, status, sync_status, owner_user_id, storefront_password, transfer_email, transfer_requested_at, created_at", {
        count: "exact",
      });
    if (q) query = query.or(`shop_domain.ilike.${likeTerm(q)},sync_status.ilike.${likeTerm(q)}`);
    return query.order("created_at", { ascending: false });
  };

  const { count } = await storeQuery().range(0, 0);
  const total = count ?? 0;
  const page = clampPage(wanted, total, size);
  const from = (page - 1) * size;
  const { data: stores } = await storeQuery().range(from, from + size - 1);

  const list = stores ?? [];

  // Beta promo: how many of the first-100 free-FULL-month slots are claimed.
  const { count: promoUsed } = await client
    .from("subscriptions")
    .select("user_id", { count: "exact", head: true })
    .eq("promo_eligible", true);
  const { count: totalSubs } = await client
    .from("subscriptions")
    .select("user_id", { count: "exact", head: true });
  const promo = promoUsed ?? 0;

  // Stores whose token Shopify has rejected. Merchants have no access to these
  // shops, so nothing happens until an admin reconnects them.
  const { data: broken } = await client
    .from("shopify_stores")
    .select("id, shop_domain, sync_status, status")
    .ilike("sync_status", "%reconnect needed%");
  const needsReconnect = broken ?? [];

  // Pool health covers every store, not just the visible page.
  const { count: availableCount } = await client
    .from("shopify_stores")
    .select("id", { count: "exact", head: true })
    .eq("status", "available");
  const availablePool = availableCount ?? 0;

  // Map owner ids → emails for a readable "assigned to" column.
  const ownerIds = [...new Set(list.map((s) => s.owner_user_id).filter(Boolean))] as string[];
  const emailById = new Map<string, string>();
  if (ownerIds.length) {
    const { data: authList } = await client.auth.admin.listUsers({ perPage: 200 });
    (authList?.users ?? []).forEach((u) => {
      if (ownerIds.includes(u.id) && u.email) emailById.set(u.id, u.email);
    });
  }

  // Map pool store → the merchant's brand name (stores.name) — the value to set
  // as the Shopify shop display name (Settings → Store details) at transfer.
  const brandById = new Map<string, string>();
  const poolIds = list.map((s) => s.id);
  if (poolIds.length) {
    const { data: linked } = await client
      .from("stores")
      .select("name, shopify_store_id")
      .in("shopify_store_id", poolIds);
    (linked ?? []).forEach((s) => {
      if (s.shopify_store_id && s.name) brandById.set(s.shopify_store_id, s.name);
    });
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink-950">Shopify stores</h1>
      <p className="mt-1 text-sm text-ink-500">
        {total} store{total === 1 ? "" : "s"} in the pool. Set each dev store&apos;s
        storefront password so its assigned merchant can preview it.
      </p>

      {needsReconnect.length > 0 && (
        <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-bold text-red-800">
            {needsReconnect.length} store{needsReconnect.length === 1 ? "" : "s"} need reconnecting
          </p>
          <p className="mt-1 text-xs text-red-700">
            Shopify has rejected the stored access token. Merchants can&apos;t fix this — open the
            EcomStrait app on each shop once to restore access. Provisioning and product sync stay
            blocked until then.
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {needsReconnect.map((s) => (
              <li key={s.id} className="text-xs font-medium text-red-800">
                <a
                  href={`https://admin.shopify.com/store/${s.shop_domain.split(".")[0]}/apps`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {s.shop_domain}
                </a>
                <span className="font-normal text-red-600"> — open the app to reconnect</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Beta ops metrics */}
      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-ink-100 bg-white p-4">
          <p className="text-xs font-medium text-ink-400">Promo slots claimed</p>
          <p className="mt-1 text-2xl font-bold text-ink-950">
            {promo}
            <span className="text-base font-medium text-ink-400"> / {PROMO_USER_LIMIT}</span>
          </p>
          <p className="mt-0.5 text-xs text-ink-400">first-100 free FULL month</p>
        </div>
        <div className="rounded-2xl border border-ink-100 bg-white p-4">
          <p className="text-xs font-medium text-ink-400">Total signups</p>
          <p className="mt-1 text-2xl font-bold text-ink-950">{totalSubs ?? 0}</p>
          <p className="mt-0.5 text-xs text-ink-400">entrepreneur subscriptions</p>
        </div>
        <div className="rounded-2xl border border-ink-100 bg-white p-4">
          <p className="text-xs font-medium text-ink-400">Available pool</p>
          <p
            className={`mt-1 text-2xl font-bold ${availablePool < 5 ? "text-amber-600" : "text-ink-950"}`}
          >
            {availablePool}
          </p>
          <p className="mt-0.5 text-xs text-ink-400">
            {availablePool < 5 ? "low — add dev stores" : "unassigned dev stores"}
          </p>
        </div>
      </div>

      <div className="mt-6">
        <SearchBar
          placeholder="Search domain or sync status…"
          summary={total > 0 ? `${from + 1}–${from + list.length} of ${total}` : undefined}
        />
      </div>

      {list.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">
          {q
            ? `No stores match “${q}”.`
            : "No Shopify stores connected yet. They appear here once the EcomStrait app is installed on a dev store."}
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-2xl border border-ink-100 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs text-ink-400">
                <th className="px-4 py-3 font-medium">Store</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Assigned to</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Storefront password</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink-900">{s.shop_domain}</p>
                    {brandById.get(s.id) ? (
                      <p className="text-xs text-ai-600">
                        Brand: <span className="font-medium">{brandById.get(s.id)}</span>
                        <span className="text-ink-300"> · set as store name in Shopify</span>
                      </p>
                    ) : (
                      <p className="text-xs text-ink-400">{s.sync_status ?? "—"}</p>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-ink-500 md:table-cell">
                    {s.owner_user_id ? emailById.get(s.owner_user_id) ?? "—" : "unassigned"}
                    {s.transfer_email && (
                      <p className="mt-0.5 text-xs font-medium text-amber-700">
                        → transfer to {s.transfer_email}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE[s.status]}`}
                    >
                      {s.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-end gap-2">
                      <StorefrontPasswordField
                        shopifyStoreId={s.id}
                        initial={s.storefront_password}
                      />
                      <TransferControl
                        shopifyStoreId={s.id}
                        transferEmail={s.transfer_email}
                        status={s.status}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination basePath="/admin/shopify-stores" params={params} page={page} total={total} size={size} />
    </div>
  );
}
