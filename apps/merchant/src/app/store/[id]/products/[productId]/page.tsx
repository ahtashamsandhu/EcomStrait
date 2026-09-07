import type { Metadata } from "next";
import { getStorefront } from "@/lib/storefront";
import { getStoreProduct } from "@/lib/storefront-api";
import { StorefrontProductDetail } from "@/lib/storefront-pages";
import { requestOrigin, storefrontMetadata } from "@/lib/storefront-seo";

/**
 * The product detail page — the single biggest structural gap this
 * storefront had against real premium references (julke.pk,
 * gomilaintersole.pk both route every product card to a full detail page;
 * ours only ever added straight to cart from the grid, with no page to link
 * to). The data layer (`getStoreProduct`, full `images[]`, `description`)
 * already existed; nothing rendered it.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; productId: string }>;
}): Promise<Metadata> {
  const { id, productId } = await params;
  const [store, product] = await Promise.all([getStorefront(id), getStoreProduct(id, productId)]);
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
    canonical: `${origin}/store/${id}/products/${productId}`,
    storeName: store.name,
    image: product.image ?? store.logoUrl,
  });
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string; productId: string }>;
}) {
  const { id, productId } = await params;
  return <StorefrontProductDetail storeId={id} productId={productId} />;
}
