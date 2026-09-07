import type { Metadata } from "next";
import Link from "next/link";
import { Search, PackageOpen, Sparkles, X } from "lucide-react";
import { clampPage, parseTableParams, type RawParams } from "@ecomstrait/ui";
import { Pagination } from "@ecomstrait/ui/pagination";
import { getPublishedCatalog, getSelectedIds, getCatalogFacets } from "@/lib/catalog";
import { getMerchantStores, getListingsFor } from "@/lib/listings";
import { ProductCard } from "@/components/catalog/product-card";
import { FilterSelect } from "@/components/catalog/filter-select";

export const metadata: Metadata = { title: "Find Products" };

/** 24 fills the 4-up grid evenly (and the 2-up grid on tablets). */
const GRID_PAGE_SIZE = 24;

export default async function FindProductsPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;
  const { q, page: wanted, size } = parseTableParams(params, GRID_PAGE_SIZE);
  const supplier = typeof params.supplier === "string" ? params.supplier : "";
  const category = typeof params.category === "string" ? params.category : "";

  const filters = { search: q, supplierId: supplier, category };
  const at = (page: number) => ({ from: (page - 1) * size, to: page * size - 1 });

  const [firstTry, selected, facets, stores] = await Promise.all([
    getPublishedCatalog(filters, at(wanted)),
    getSelectedIds(),
    getCatalogFacets(),
    getMerchantStores(),
  ]);

  // Only re-query when the requested page fell past the end of the result set.
  const page = clampPage(wanted, firstTry.total, size);
  const { products, total } =
    page === wanted ? firstTry : await getPublishedCatalog(filters, at(page));

  // One lookup for the whole page rather than one per card.
  const listings = await getListingsFor(products.map((p) => p.id));

  const filtering = Boolean(q || supplier || category);
  const supplierName = facets.suppliers.find((s) => s.id === supplier)?.name;
  const from = (page - 1) * size;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-950">Find Products</h1>
          <p className="mt-1 text-sm text-ink-500">
            Browse products from verified suppliers and add them to your inventory.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/inventory"
            className="inline-flex items-center gap-2 rounded-xl border border-ink-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink-800 hover:bg-ink-50"
          >
            <PackageOpen className="h-4 w-4" /> Selected ({selected.size})
          </Link>
          {selected.size > 0 ? (
            <Link
              href="/builder"
              className="inline-flex items-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
            >
              <Sparkles className="h-4 w-4" /> Create a store with selected inventory
            </Link>
          ) : (
            <span
              title="Select at least one product first"
              className="inline-flex cursor-not-allowed items-center gap-2 rounded-xl bg-ink-100 px-4 py-2.5 text-sm font-semibold text-ink-400"
            >
              <Sparkles className="h-4 w-4" /> Create a store with selected inventory
            </span>
          )}
        </div>
      </div>

      {/* Changing a filter must land on page 1 — the old page number would
          otherwise point past the end of the new, smaller result set. */}
      <form className="mt-5 flex flex-wrap items-center gap-2">
        <input type="hidden" name="page" value="1" />
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-ink-200 bg-white px-4 py-1.5 sm:max-w-md">
          <Search className="h-4 w-4 shrink-0 text-ink-400" />
          <input
            name="q"
            defaultValue={q}
            placeholder="Search products…"
            aria-label="Search products"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-ink-400"
          />
          <button
            type="submit"
            className="shrink-0 rounded-full bg-brand-500 px-4 py-1.5 text-sm font-semibold text-white hover:bg-brand-600"
          >
            Search
          </button>
        </div>

        <FilterSelect
          key={`supplier:${supplier}`}
          name="supplier"
          value={supplier}
          allLabel="All suppliers"
          ariaLabel="Filter by supplier"
          options={facets.suppliers.map((s) => ({ value: s.id, label: s.name }))}
        />
        <FilterSelect
          key={`category:${category}`}
          name="category"
          value={category}
          allLabel="All niches"
          ariaLabel="Filter by niche"
          options={facets.categories.map((c) => ({ value: c, label: c }))}
        />

        {filtering && (
          <Link
            href="/find-suppliers"
            className="inline-flex items-center gap-1 rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-semibold text-ink-600 hover:bg-ink-50"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </Link>
        )}
      </form>

      {total > 0 && (
        <p className="mt-3 text-sm text-ink-500">
          {from + 1}–{from + products.length} of {total}
          {supplierName ? ` from ${supplierName}` : ""}
          {category ? ` in ${category}` : ""}
          {q ? ` matching “${q}”` : ""}
        </p>
      )}

      <div className="mt-6">
        {products.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-ink-200 bg-white p-12 text-center">
            <PackageOpen className="h-8 w-8 text-ink-300" />
            <p className="mt-3 text-sm text-ink-500">
              {filtering
                ? "No products match those filters."
                : "No published products yet — suppliers are still onboarding."}
            </p>
            {filtering && (
              <Link href="/find-suppliers" className="mt-3 text-sm font-semibold text-brand-600 hover:underline">
                Clear filters
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {products.map((p) => (
                <ProductCard
                  key={p.id}
                  product={p}
                  selected={selected.has(p.id)}
                  stores={stores}
                  listings={listings[p.id] ?? {}}
                />
              ))}
            </div>
            <Pagination
              basePath="/find-suppliers"
              params={params}
              page={page}
              total={total}
              size={size}
            />
          </>
        )}
      </div>
    </div>
  );
}
