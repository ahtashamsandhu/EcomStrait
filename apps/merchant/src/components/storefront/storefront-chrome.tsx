"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ShoppingBag, Plus, Minus, Loader2, X, Menu, ChevronDown } from "lucide-react";
import { useClickOutside } from "@ecomstrait/ui";
import type { Storefront } from "@/lib/storefront";
import { useStorefrontCart } from "@/components/storefront/use-storefront";
import { usePreviewCart } from "@/components/storefront/use-preview-cart";
import { NewsletterForm } from "@/components/storefront/newsletter-form";

/**
 * Header, cart drawer, and footer — the chrome every storefront page shares
 * (the homepage, and the product detail page). Pulled out of what used to be
 * one monolithic `StorefrontView` so a second page (the product detail view)
 * doesn't have to duplicate the cart drawer or re-fetch the cart separately —
 * one `useStorefrontCart` call here, shared down through context, so the
 * header's cart badge and a product page's "Add to cart" always agree.
 */

type CartApi = ReturnType<typeof useStorefrontCart>;
const CartContext = createContext<CartApi | null>(null);

export function useStorefrontCartContext(): CartApi {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useStorefrontCartContext must be used inside <StorefrontChrome>");
  return ctx;
}

/**
 * `children` bundles a store's individual category links under one nav
 * entry (e.g. "Categories") so a store with several categories shows one
 * dropdown tab instead of one tab per category — see `getStorefrontNav` in
 * storefront-api.ts, the sole place this array gets built for a live store.
 */
export type NavLink = { label: string; href: string; children?: NavLink[] };

type ChromeProps = {
  store: Storefront;
  navLinks: NavLink[];
  /** `/store/<uuid>` on the id-path route, `""` on a connected domain. */
  basePath: string;
  children: React.ReactNode;
  /** Inside the Store Builder's live preview, for an unlaunched/draft store.
   *  Swaps the real, backend-backed cart for a local one (see below) and
   *  tells NewsletterForm not to actually submit — both because a draft
   *  store's id is refused by the real APIs (the same way getStorefront
   *  refuses it, storefront.ts), and because a merchant clicking around
   *  their own in-progress store shouldn't create real cart/subscriber rows
   *  against a store nobody can actually buy from yet. */
  previewMode?: boolean;
};

/**
 * `previewMode` picks between two real hooks, not a runtime branch inside
 * one — `useStorefrontCart` fires a network request on mount regardless of
 * whether its result is used, so it can't be called and then ignored, and a
 * hook can't be called conditionally within a single component body either
 * way (rules of hooks). Dispatching to one of two thin wrapper components
 * keeps each hook call unconditional within its own component, and
 * `previewMode` doesn't change for the lifetime of a mounted instance (a
 * given render is either a preview or the real thing, never both), so this
 * never actually remounts anything in practice.
 */
export function StorefrontChrome(props: ChromeProps) {
  return props.previewMode ? <PreviewChrome {...props} /> : <LiveChrome {...props} />;
}

function LiveChrome(props: Omit<ChromeProps, "previewMode">) {
  return <ChromeBody {...props} cartApi={useStorefrontCart(props.store.id)} previewMode={false} />;
}

function PreviewChrome(props: Omit<ChromeProps, "previewMode">) {
  return <ChromeBody {...props} cartApi={usePreviewCart(props.store.products)} previewMode />;
}

function ChromeBody({
  store,
  navLinks,
  basePath,
  children,
  cartApi,
  previewMode,
}: Omit<ChromeProps, "previewMode"> & { cartApi: CartApi; previewMode: boolean }) {
  const { cart, isPending, error, setQuantity, remove, checkout } = cartApi;
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Which mobile-drawer dropdown entries (e.g. "Categories") are expanded —
  // keyed by href, since the drawer has no hover to rely on: tapping the
  // entry toggles its sublist open instead of navigating away immediately.
  const [openDropdowns, setOpenDropdowns] = useState<Set<string>>(new Set());
  function toggleDropdown(href: string) {
    setOpenDropdowns((prev) => {
      const next = new Set(prev);
      if (next.has(href)) next.delete(href);
      else next.add(href);
      return next;
    });
  }

  // Mirrors the Shopify Liquid themes' own nav drawer (assets/theme.js,
  // initNav): closing on Escape and on crossing back to desktop width isn't
  // just for parity — without the resize handler, narrowing the window back
  // down again (without ever touching the hamburger) would show the mobile
  // nav already open.
  useEffect(() => {
    if (!menuOpen) return;
    const desktopQuery = window.matchMedia("(min-width: 640px)");
    const onDesktopChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMenuOpen(false);
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    desktopQuery.addEventListener("change", onDesktopChange);
    document.addEventListener("keydown", onKeydown);
    return () => {
      desktopQuery.removeEventListener("change", onDesktopChange);
      document.removeEventListener("keydown", onKeydown);
    };
  }, [menuOpen]);

  const line = "color-mix(in srgb, var(--ink) 12%, transparent)";
  const surface = "color-mix(in srgb, var(--ink) 4%, var(--bg))";
  // The mobile nav panel is in-flow, not an overlay — nothing else stops a
  // click elsewhere on the page from doing something else while it's still
  // open. Ref covers the whole header (hamburger button included), so this
  // only fires for a genuine click outside it, not the toggle click itself.
  const mobileNavRef = useClickOutside<HTMLElement>(menuOpen, () => setMenuOpen(false));

  return (
    <CartContext.Provider value={cartApi}>
      {store.plan.announcement && (
        <div
          className="px-4 py-2.5 text-center text-xs font-semibold"
          style={{ background: "var(--brand)", color: "#fff", letterSpacing: "0.04em" }}
        >
          {store.plan.announcement}
        </div>
      )}

      <header
        ref={mobileNavRef}
        className="sticky top-0 z-20 border-b backdrop-blur"
        style={{ background: "color-mix(in srgb, var(--bg) 90%, transparent)", borderColor: line }}
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href={basePath || "/"} className="shrink-0">
            {store.logoUrl ? (
              // Actual width varies per store (an uploaded logo, unknown
              // aspect ratio) — width/height here are just a sizing hint for
              // next/image's optimizer; `w-auto` lets the real ratio show.
              <Image src={store.logoUrl} alt={store.name} width={160} height={40} className="h-7 w-auto object-contain" priority />
            ) : (
              <span
                className="text-lg font-semibold"
                style={{ fontFamily: "var(--font-heading)", letterSpacing: "0.02em" }}
              >
                {store.name}
              </span>
            )}
          </Link>

          {navLinks.length > 0 && (
            <nav className="hidden items-center gap-8 sm:flex">
              {navLinks.map((l) =>
                l.children?.length ? (
                  // Hover-opened on desktop — `group-focus-within` keeps it
                  // reachable by keyboard too, not just a mouse.
                  <div key={l.href} className="group relative">
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs font-semibold uppercase opacity-70 transition hover:opacity-100"
                      style={{ letterSpacing: "0.1em" }}
                    >
                      {l.label}
                      <ChevronDown className="h-3 w-3 transition group-hover:rotate-180" />
                    </button>
                    <div className="invisible absolute left-1/2 top-full z-30 -translate-x-1/2 pt-3 opacity-0 transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
                      <div
                        className="flex flex-col gap-1 border p-2 shadow-lg"
                        style={{ background: "var(--bg)", borderColor: line, borderRadius: "var(--radius)" }}
                      >
                        {l.children.map((c) => (
                          <a
                            key={c.href}
                            href={c.href}
                            className="whitespace-nowrap px-3 py-2 text-xs font-medium opacity-70 transition hover:opacity-100"
                          >
                            {c.label}
                          </a>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <a
                    key={l.href}
                    href={l.href}
                    className="text-xs font-semibold uppercase opacity-70 transition hover:opacity-100"
                    style={{ letterSpacing: "0.1em" }}
                  >
                    {l.label}
                  </a>
                ),
              )}
            </nav>
          )}

          <div className="flex items-center gap-2">
            {navLinks.length > 0 && (
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="grid h-9 w-9 place-items-center transition hover:opacity-60 sm:hidden"
                aria-label={menuOpen ? "Close menu" : "Menu"}
                aria-expanded={menuOpen}
              >
                {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
            )}
            <button
              onClick={() => setOpen(true)}
              className="relative grid h-9 w-9 place-items-center transition hover:opacity-60"
              aria-label={`Cart, ${cart.itemCount} item${cart.itemCount === 1 ? "" : "s"}`}
            >
              <ShoppingBag className="h-5 w-5" />
              {cart.itemCount > 0 && (
                <span
                  className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold"
                  style={{ background: "var(--brand)", color: "#fff" }}
                >
                  {cart.itemCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Mobile nav — the header's own <nav> is hidden below `sm`
            (`hidden ... sm:flex` above) with nothing replacing it, so
            categories/Shop all/Sale/About were completely unreachable except
            by scrolling to the footer. `sm:hidden` here means this can never
            show once the real nav reappears at 640px+. */}
        {menuOpen && navLinks.length > 0 && (
          <nav className="flex flex-col border-t px-6 py-3 sm:hidden" style={{ borderColor: line }}>
            {navLinks.map((l) =>
              l.children?.length ? (
                // No hover on touch — tapping the entry expands its sublist
                // in place instead of navigating away.
                <div key={l.href}>
                  <button
                    type="button"
                    onClick={() => toggleDropdown(l.href)}
                    aria-expanded={openDropdowns.has(l.href)}
                    className="flex w-full items-center justify-between py-2.5 text-xs font-semibold uppercase opacity-70 transition hover:opacity-100"
                    style={{ letterSpacing: "0.1em" }}
                  >
                    {l.label}
                    <ChevronDown
                      className="h-3.5 w-3.5 transition"
                      style={{ transform: openDropdowns.has(l.href) ? "rotate(180deg)" : undefined }}
                    />
                  </button>
                  {openDropdowns.has(l.href) && (
                    <div className="flex flex-col pl-4">
                      {l.children.map((c) => (
                        <a
                          key={c.href}
                          href={c.href}
                          onClick={() => setMenuOpen(false)}
                          className="py-2 text-xs font-medium opacity-70 transition hover:opacity-100"
                        >
                          {c.label}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setMenuOpen(false)}
                  className="py-2.5 text-xs font-semibold uppercase opacity-70 transition hover:opacity-100"
                  style={{ letterSpacing: "0.1em" }}
                >
                  {l.label}
                </a>
              ),
            )}
          </nav>
        )}
      </header>

      {children}

      <footer className="border-t px-6 py-14" style={{ borderColor: line }}>
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 text-center">
          {navLinks.length > 0 && (
            <nav className="flex flex-wrap justify-center gap-6">
              {/* The footer is a flat list with no hover/tap affordance of its
                  own, so a bundled dropdown entry (e.g. "Categories") is
                  unpacked back into its individual category links here rather
                  than shown as an unclickable label. */}
              {navLinks
                .flatMap((l) => (l.children?.length ? l.children : [l]))
                .map((l) => (
                  <a
                    key={l.href}
                    href={l.href}
                    className="text-xs font-semibold uppercase opacity-60 transition hover:opacity-100"
                    style={{ letterSpacing: "0.08em" }}
                  >
                    {l.label}
                  </a>
                ))}
            </nav>
          )}
          <div className="flex flex-col items-center gap-3">
            <p className="text-xs font-semibold uppercase opacity-70" style={{ letterSpacing: "0.1em" }}>
              Stay in the loop
            </p>
            <NewsletterForm storeId={store.id} previewMode={previewMode} />
          </div>
          <p className="text-xs opacity-50" style={{ letterSpacing: "0.04em" }}>
            {store.plan.footerText || `${store.name} · Powered by EcomStrait`}
          </p>
        </div>
      </footer>

      {open && (
        <div className="fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/45" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-0 flex h-full w-full max-w-sm flex-col shadow-2xl"
            style={{ background: "var(--bg)", color: "var(--ink)" }}
          >
            <div className="flex items-center justify-between border-b px-6 py-5" style={{ borderColor: line }}>
              <p className="text-sm font-semibold uppercase" style={{ letterSpacing: "0.08em" }}>
                Your cart
              </p>
              <button onClick={() => setOpen(false)} aria-label="Close" className="opacity-60 hover:opacity-100">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {cart.removed.length > 0 && (
                <p
                  className="mb-4 px-3 py-2 text-xs"
                  style={{ borderRadius: "var(--radius)", background: "color-mix(in srgb, #f59e0b 15%, var(--bg))" }}
                >
                  {cart.removed.length} item{cart.removed.length === 1 ? " was" : "s were"} removed —
                  no longer available.
                </p>
              )}
              {cart.adjusted.length > 0 && (
                <p
                  className="mb-4 px-3 py-2 text-xs"
                  style={{ borderRadius: "var(--radius)", background: "color-mix(in srgb, #f59e0b 15%, var(--bg))" }}
                >
                  Quantities reduced to the stock on hand.
                </p>
              )}

              {cart.lines.length === 0 ? (
                <p className="text-sm opacity-50">Your cart is empty.</p>
              ) : (
                <ul className="flex flex-col gap-5">
                  {cart.lines.map((l) => {
                    // Each button in this row tracks only its own action —
                    // "-" and "+" both call `setQuantity`, so they're split
                    // by an explicit pending key rather than sharing one,
                    // otherwise clicking "+" would also spin "-".
                    const decPending = isPending(`qty-dec:${l.productId}`);
                    const incPending = isPending(`qty-inc:${l.productId}`);
                    const removePending = isPending(`remove:${l.productId}`);
                    return (
                      <li key={l.productId} className="flex items-center gap-3">
                        <span
                          className="relative block h-14 w-14 shrink-0 overflow-hidden"
                          style={{ background: surface, borderRadius: "var(--radius)" }}
                        >
                          {l.image ? <Image src={l.image} alt="" fill sizes="56px" className="object-cover" /> : null}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-1 text-sm font-medium">{l.title}</p>
                          <p className="text-xs opacity-60">${l.unitPrice.toFixed(2)}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setQuantity(l.productId, l.quantity - 1, `qty-dec:${l.productId}`)}
                            disabled={decPending}
                            aria-label="Decrease quantity"
                            className="grid h-7 w-7 place-items-center border opacity-70 disabled:opacity-30"
                            style={{ borderColor: line, borderRadius: "var(--radius)" }}
                          >
                            {decPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Minus className="h-3.5 w-3.5" />}
                          </button>
                          <span className="w-6 text-center text-sm">{l.quantity}</span>
                          <button
                            onClick={() => setQuantity(l.productId, l.quantity + 1, `qty-inc:${l.productId}`)}
                            disabled={incPending || l.quantity >= l.available}
                            aria-label="Increase quantity"
                            className="grid h-7 w-7 place-items-center border opacity-70 disabled:opacity-30"
                            style={{ borderColor: line, borderRadius: "var(--radius)" }}
                          >
                            {incPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            onClick={() => remove(l.productId)}
                            disabled={removePending}
                            aria-label={`Remove ${l.title}`}
                            className="ml-1 grid h-7 w-7 place-items-center opacity-50 transition hover:text-red-500 hover:opacity-100 disabled:opacity-30"
                          >
                            {removePending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="border-t p-6" style={{ borderColor: line }}>
              <div className="mb-4 flex items-center justify-between text-sm">
                <span className="opacity-60">Subtotal</span>
                <span className="font-semibold">${cart.subtotal.toFixed(2)}</span>
              </div>
              {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
              <button
                onClick={checkout}
                disabled={isPending("checkout") || cart.lines.length === 0}
                className="inline-flex h-12 w-full items-center justify-center gap-2 text-sm font-semibold uppercase text-white transition hover:opacity-85 disabled:opacity-40"
                style={{ background: "var(--brand)", borderRadius: "var(--radius)", letterSpacing: "0.08em" }}
              >
                {isPending("checkout") ? <Loader2 className="h-4 w-4 animate-spin" /> : "Checkout"}
              </button>
            </div>
          </div>
        </div>
      )}
    </CartContext.Provider>
  );
}
