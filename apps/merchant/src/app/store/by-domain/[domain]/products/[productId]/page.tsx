import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getStorefront, resolveStoreIdByDomain } from "@/lib/storefront";
import { getStoreProduct } from "@/lib/storefront-api";
import { StorefrontProductDetail } from "@/lib/storefront-pages";
import { requestOrigin, storefrontMetadata } from "@/lib/storefront-seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ domain: string; productId: string }>;
}): Promise<Metadata> {
  const { domain, productId } = await params;
  const storeId = await resolveStoreIdByDomain(decodeURIComponent(domain));
  const [store, product] = storeId
    ? await Promise.all([getStorefront(storeId), getStoreProduct(storeId, productId)])
    : [null, null];
  if (!store || !product) return { title: "Product" };
  const origin = await requestOrigin();
  // Supplier-authored SEO fields first (products.seo_title/seo_description —
  // dead fields until 2026-09-07); storefrontMetadata()'s clamp stays the
  // length guarantee either way.
  return storefrontMetadata({
    title: product.seoTitle ? `${product.seoTitle} · ${store.name}` : `${product.title} · ${store.name}`,
    description:
      product.seoDescription ||
      product.description ||
      store.plan.seoDescription ||
      `${product.title} at ${store.name}.`,
    canonical: `${origin}/products/${productId}`,
    storeName: store.name,
    image: product.image ?? store.logoUrl,
  });
}

export default async function ProductByDomainPage({
  params,
}: {
  params: Promise<{ domain: string; productId: string }>;
}) {
  const { domain, productId } = await params;
  const storeId = await resolveStoreIdByDomain(decodeURIComponent(domain));
  if (!storeId) notFound();
  return <StorefrontProductDetail storeId={storeId} productId={productId} basePath="" />;
}
