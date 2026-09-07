import "server-only";

import { headers } from "next/headers";
import type { Metadata } from "next";
import { siteUrl } from "@/lib/site-url";
import type { ApiProduct } from "@/lib/storefront-api";

/**
 * SEO for the public storefront — metadata and structured data, shared by
 * every `/store/[id]/*` and `/store/by-domain/[domain]/*` page so the two
 * routes into the same store can't drift.
 */

/**
 * The origin actually serving this request — a merchant's own connected
 * domain when reached that way, the shared merchant host otherwise. Every
 * canonical/OG URL has to reflect wherever a crawler actually found the
 * page, not always the shared host: a customer's browser (and Google) sees
 * `yourbrand.com`, not `os-merchant.vercel.app/store/<uuid>`.
 */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("host");
  if (!host) return siteUrl();
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Google's practical sweet spot for how a title/description actually
 * renders in a search result — long enough to read as complete, short
 * enough not to get truncated. Same convention `enrichProduct`'s prompt
 * already asks for on the supplier side (apps/supplier/src/lib/ai.ts);
 * enforced here in code rather than only asked for in a prompt, since an AI
 * response (or a hand-written fallback string) can't be trusted to land in
 * range on its own — an Ahrefs audit flagging "title too long" / "meta
 * description too short/too long" across a live storefront is exactly what
 * this guarantees can't happen again, for every page, regardless of source.
 */
const TITLE_MAX = 60;
const DESCRIPTION_MIN = 120;
const DESCRIPTION_MAX = 155;

/** Cuts at the last whole word, leaving room for the trailing "…" so the
 *  result is never more than `max` characters — not `max + 1`. */
function clampLength(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const budget = max - 1;
  const cut = clean.slice(0, budget).replace(/\s+\S*$/, "");
  // A single word longer than `budget` (rare, but possible — no whitespace
  // to cut back to) has nothing to trim — fall back to a hard slice rather
  // than emit an empty string.
  return `${cut || clean.slice(0, budget)}…`;
}

function clampTitle(title: string): string {
  return clampLength(title, TITLE_MAX);
}

/**
 * Appended one at a time until the description clears `DESCRIPTION_MIN` —
 * a single short sentence isn't reliably enough on its own (a one-word store
 * name plus an empty AI description would still land under 120 chars after
 * just one), so this keeps adding until it's actually cleared, then the
 * caller clamps back down if that overshot `DESCRIPTION_MAX`.
 */
function descriptionFillers(storeName: string): string[] {
  return [
    `Shop the full ${storeName} collection — quality picks, fast shipping, and easy returns.`,
    "New arrivals and customer favorites are added regularly, so there's always something worth browsing.",
  ];
}

/**
 * Never returns something shorter than `DESCRIPTION_MIN` — a short AI
 * response or a terse fallback string (`Shop ${name}.`) gets generic,
 * store-named closers appended rather than left as thin, easily-flagged
 * copy. Re-clamped to `DESCRIPTION_MAX` afterward in case that overshoots.
 */
function clampDescription(description: string, storeName: string): string {
  const clean = description.trim();
  if (clean.length > DESCRIPTION_MAX) return clampLength(clean, DESCRIPTION_MAX);

  let result = clean;
  for (const filler of descriptionFillers(storeName)) {
    if (result.length >= DESCRIPTION_MIN) break;
    const joiner = result && !/[.!?]$/.test(result) ? "." : "";
    result = result ? `${result}${joiner} ${filler}` : filler;
  }
  return result.length > DESCRIPTION_MAX ? clampLength(result, DESCRIPTION_MAX) : result;
}

/**
 * Metadata every public storefront page needs, folded into one place.
 *
 * `robots: { index: true }` is not optional here — the merchant app's root
 * layout sets `index: false` for the dashboard, and Next.js merges metadata
 * down the tree; a storefront page that left `robots` unset would silently
 * inherit "don't index me" from the dashboard layout above it. That bug
 * would have made every merchant's storefront invisible to search engines
 * regardless of how good its content was.
 */
export function storefrontMetadata({
  title,
  description,
  canonical,
  storeName,
  image,
}: {
  title: string;
  description: string;
  /** Absolute URL — build with `requestOrigin()` + the page's own path. */
  canonical: string;
  storeName: string;
  /** Absolute image URL for OG/Twitter — a product photo, or the store's logo. */
  image?: string | null;
}): Metadata {
  const t = clampTitle(title);
  const d = clampDescription(description, storeName);
  return {
    title: t,
    description: d,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
      title: t,
      description: d,
      url: canonical,
      siteName: storeName,
      type: "website",
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title: t,
      description: d,
      ...(image ? { images: [image] } : {}),
    },
  };
}

/** Trims AI-written copy to something a meta description tag can hold, without cutting mid-word. */
export function truncateForMeta(text: string, max = 160): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

type JsonLd = Record<string, unknown>;

/**
 * Renders a JSON-LD block.
 *
 * The data includes supplier-written product titles and descriptions, and
 * `JSON.stringify` does not escape `</script>` — so a product called
 * `x</script><script>…` would break out of the tag and run on the storefront
 * origin. Escaping `<`, `>` and `&` as \uXXXX keeps the JSON valid (parsers
 * decode the escapes) while making it inert as HTML; U+2028/2029 are escaped
 * because they are line terminators in JS but not in JSON.
 */
export function JsonLdScript({ data }: { data: JsonLd }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonForHtml(data) }} />;
}

export function safeJsonForHtml(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function organizationJsonLd({
  name,
  origin,
  logoUrl,
}: {
  name: string;
  origin: string;
  logoUrl?: string | null;
}): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name,
    url: origin,
    ...(logoUrl ? { logo: logoUrl } : {}),
  };
}

export function websiteJsonLd({ name, origin }: { name: string; origin: string }): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name,
    url: origin,
  };
}

/** The current page's products, in the order shown — not a whole category, just what's actually on this page. */
export function itemListJsonLd(items: { name: string; url: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      url: item.url,
    })),
  };
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/** Real data only: availability/price come straight from the priced catalog, never guessed. */
export function productJsonLd({
  product,
  url,
  currency = "USD",
}: {
  product: ApiProduct;
  url: string;
  currency?: string;
}): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    ...(product.description ? { description: product.description } : {}),
    ...(product.images.length ? { image: product.images } : {}),
    ...(product.category ? { category: product.category } : {}),
    offers: {
      "@type": "Offer",
      url,
      priceCurrency: currency,
      ...(product.price != null ? { price: product.price } : {}),
      availability: product.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
  };
}

export function articleJsonLd({
  title,
  description,
  url,
  image,
  publishedAt,
  authorName,
}: {
  title: string;
  description?: string | null;
  url: string;
  image?: string | null;
  publishedAt: string;
  authorName: string;
}): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    ...(description ? { description } : {}),
    ...(image ? { image: [image] } : {}),
    datePublished: publishedAt,
    author: { "@type": "Organization", name: authorName },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
  };
}
