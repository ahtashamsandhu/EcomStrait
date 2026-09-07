import type { Metadata } from "next";
import Link from "next/link";
import { PackageOpen, Search, Sparkles, X } from "lucide-react";
import { getMerchantStores, getMerchantListings } from "@/lib/listings";
import { getSelectedProducts, productImage } from "@/lib/catalog";
import { ListingCard } from "@/components/inventory/listing-card";
import { PreLaunchSelectionCard } from "@/components/inventory/pre-launch-card";
import { FilterSelect } from "@/components/catalog/filter-select";

export const metadata: Metadata = { title: "Selected Inventory" };

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; status?: string }>;
}) {
  const { store = "", status = "" } = await searchParams;

  // `all` is every product actually attached to one of this merchant's real
  // stores (`store_products`); `preLaunch` is the separate `selected_products`
  // basket — products chosen from Find Suppliers (or a Store Builder
  // suggestion) before being put on any store at all, including a brand-new
  // account with no store yet. Both belong on this page — a real bug this
  // fixed: `preLaunch` items used to not be fetched here at all, so a
  // merchant who had only ever selected products (never built a store) saw
  // an empty "Nothing listed yet" page despite having real selections.
  const [stores, all, preLaunchProducts] = await Promise.all([
    getMerchantStores(),
    getMerchantListings(),
    getSelectedProducts(),
  ]);
  // Resolved to plain fields here (server component) rather than in the
  // client card — see pre-launch-card.tsx's note on why it can't import
  // `catalog.ts` (server-only) itself.
  const preLaunch = preLaunchProducts.map((p) => ({
    id: p.id,
    title: p.title,
    image: productImage(p.images?.[0]),
    price: p.retail_price,
    supplierName: p.supplier_name,
  }));

  // An unrecognised store id would otherwise fall through and show everything.
  const validStore = stores.some((s) => s.id === store) ? store : "";
  const listings = all.filter(
    (l) => (!validStore || l.storeId === validStore) && (!status || l.status === status),
  );

  const counts = {
    all: all.length,
    pending: all.filter((l) => l.status === "pending").length,
    approved: all.filter((l) => l.status === "approved").length,
    declined: all.filter((l) => l.status === "declined").length,
  };
  const filtering = Boolean(validStore || status);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-950">Selected Inventory</h1>
          <p className="mt-1 text-sm text-ink-500">
            The products you&apos;re selling, and which store each one is on.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/find-suppliers"
            className="inline-flex items-center gap-2 rounded-xl border border-ink-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink-800 hover:bg-ink-50"
          >
            <Search className="h-4 w-4" /> Find more products
          </Link>
          {/* Same action, same target, same styling as the identical button on
              Find Suppliers (find-suppliers/page.tsx) — /builder reads the
              selected_products basket itself, so there's nothing to pass
              through. Only shown once there's something queued for it to build
              around; unlike Find Suppliers this page has no reason to show a
              disabled placeholder when the basket is empty. */}
          {preLaunch.length > 0 && (
            <Link
              href="/builder"
              className="inline-flex items-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
            >
              <Sparkles className="h-4 w-4" /> Create a store with selected inventory
            </Link>
          )}
        </div>
      </div>

      {all.length > 0 && (
        <form className="mt-5 flex flex-wrap items-center gap-2">
          <FilterSelect
            key={`store:${validStore}`}
            name="store"
            value={validStore}
            allLabel={`All stores (${counts.all})`}
            ariaLabel="Filter by store"
            options={stores.map((s) => ({ value: s.id, label: s.name }))}
          />
          <FilterSelect
            key={`status:${status}`}
            name="status"
            value={status}
            allLabel="Any status"
            ariaLabel="Filter by listing status"
            options={[
              { value: "approved", label: `Listed (${counts.approved})` },
              { value: "pending", label: `Awaiting supplier (${counts.pending})` },
              { value: "declined", label: `Declined (${counts.declined})` },
            ]}
          />
          {filtering && (
            <Link
              href="/inventory"
              className="inline-flex items-center gap-1 rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-semibold text-ink-600 hover:bg-ink-50"
            >
              <X className="h-3.5 w-3.5" /> Clear
            </Link>
          )}
          <span className="text-sm text-ink-500">
            {listings.length} of {counts.all}
          </span>
        </form>
      )}

      {preLaunch.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-ink-800">
            Not yet on a store ({preLaunch.length})
          </h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Queued from Find Products, waiting for a store to be built or added to one you already
            have.
          </p>
          <div className="mt-3 grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {preLaunch.map((p) => (
              <PreLaunchSelectionCard key={p.id} product={p} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-6">
        {all.length === 0 && preLaunch.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-ink-200 bg-white p-12 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-ink-100 text-ink-400">
              <PackageOpen className="h-7 w-7" />
            </span>
            <p className="mt-4 max-w-sm text-sm text-ink-500">
              Nothing listed yet. Browse products and add them to one of your stores.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Link
                href="/find-suppliers"
                className="inline-flex items-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
              >
                <Search className="h-4 w-4" /> Find Products
              </Link>
              <Link
                href="/builder"
                className="inline-flex items-center gap-2 rounded-xl border border-ink-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink-800 hover:bg-ink-50"
              >
                <Sparkles className="h-4 w-4" /> Build a store
              </Link>
            </div>
          </div>
        ) : all.length === 0 ? null : (
          <>
            {preLaunch.length > 0 && <h2 className="mb-3 text-sm font-semibold text-ink-800">Listed on your stores</h2>}
            {listings.length === 0 ? (
              <div className="grid place-items-center rounded-2xl border border-dashed border-ink-200 bg-white p-12 text-center">
                <p className="text-sm text-ink-500">Nothing matches those filters.</p>
                <Link href="/inventory" className="mt-3 text-sm font-semibold text-brand-600 hover:underline">
                  Clear filters
                </Link>
              </div>
            ) : (
              <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {listings.map((l) => (
                  <ListingCard key={`${l.storeId}:${l.productId}`} listing={l} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
