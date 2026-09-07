"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Clock, Loader2, Plus, Sparkles, X } from "lucide-react";
import { cn, useClickOutside } from "@ecomstrait/ui";
import type { ListingStatus } from "@ecomstrait/db/types";
import type { StoreOption } from "@/lib/listings";
import { requestListing, removeListing } from "@/lib/listing-actions";
import { addSelectedProduct, removeSelectedProduct } from "@/lib/catalog-actions";

const STATE: Record<ListingStatus, { label: string; cls: string }> = {
  pending: { label: "Awaiting supplier", cls: "text-amber-700" },
  approved: { label: "Listed", cls: "text-brand-700" },
  declined: { label: "Declined", cls: "text-red-600" },
};

/**
 * "Add to store" control. A merchant picks which of their EXISTING stores to
 * list the product on (row starts pending until the supplier approves it) —
 * or queues it for a store they haven't built yet.
 *
 * That second option matters once a merchant has any store at all: this menu
 * replaces `AddButton` entirely on `ProductCard` at that point (see there),
 * which used to make `selected_products` — the basket "Create a store with
 * selected inventory" on Find Suppliers builds from — permanently
 * unreachable the moment a first store existed. A merchant with 2 stores
 * had no way to pick products for a 3rd.
 */
export function ListingMenu({
  productId,
  stores,
  listings,
  selected,
}: {
  productId: string;
  stores: StoreOption[];
  /** storeId → status for this product. */
  listings: Record<string, ListingStatus>;
  /** Already queued in the pre-store basket, for a store not built yet. */
  selected: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const menuRef = useClickOutside<HTMLDivElement>(open, () => setOpen(false));

  const listedCount = Object.values(listings).filter((s) => s !== "declined").length;

  function act(storeId: string, current: ListingStatus | undefined) {
    setError(null);
    start(async () => {
      const res = current ? await removeListing(storeId, productId) : await requestListing(storeId, productId);
      if (res.error) setError(res.error);
      else setOpen(false);
      router.refresh();
    });
  }

  function toggleNewStore() {
    setError(null);
    start(async () => {
      const res = selected ? await removeSelectedProduct(productId) : await addSelectedProduct(productId);
      if (res?.error) setError(res.error);
      else setOpen(false);
      router.refresh();
    });
  }

  const summaryLabel =
    listedCount > 0
      ? `On ${listedCount} store${listedCount === 1 ? "" : "s"}`
      : selected
        ? "In new store"
        : "Add to store";

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={pending}
        aria-expanded={open}
        className={cn(
          "inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-sm font-semibold transition disabled:opacity-60",
          listedCount > 0 || selected
            ? "border border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100"
            : "bg-brand-500 text-white hover:bg-brand-600",
        )}
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : listedCount > 0 || selected ? (
          <>
            <Check className="h-4 w-4" /> {summaryLabel}
            <ChevronDown className="h-3.5 w-3.5" />
          </>
        ) : (
          <>
            <Plus className="h-4 w-4" /> {summaryLabel}
            <ChevronDown className="h-3.5 w-3.5" />
          </>
        )}
      </button>

      {open && (
        <div className="absolute bottom-11 left-0 right-0 z-30 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-lg">
          <p className="border-b border-ink-100 px-3 py-2 text-xs font-semibold text-ink-500">
            List on
          </p>
          <ul className="max-h-56 overflow-y-auto">
            {stores.map((s) => {
              const status = listings[s.id];
              return (
                <li key={s.id}>
                  <button
                    onClick={() => act(s.id, status)}
                    disabled={pending}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-ink-50 disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-ink-800">{s.name}</span>
                      {status && (
                        <span className={cn("block text-[11px]", STATE[status].cls)}>
                          {STATE[status].label}
                        </span>
                      )}
                    </span>
                    {status === "pending" ? (
                      <Clock className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                    ) : status === "approved" ? (
                      <X className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                    ) : (
                      <Plus className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-ink-100 p-1">
            <button
              onClick={toggleNewStore}
              disabled={pending}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-ink-50 disabled:opacity-50"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-ink-800">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-brand-500" />
                Start a new store
              </span>
              {selected ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />
              ) : (
                <Plus className="h-3.5 w-3.5 shrink-0 text-ink-400" />
              )}
            </button>
          </div>
          {error && <p className="border-t border-ink-100 px-3 py-2 text-[11px] text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
