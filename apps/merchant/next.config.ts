import type { NextConfig } from "next";

// Storefront images come from two places:
//  - Product photos and store logos: this Supabase project's public storage
//    buckets, served from
//    `${NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/<bucket>/...`.
//  - Store media library uploads (blog cover images, and any hero/about/
//    gallery media picked from it) go through `/api/media`
//    (lib/media.ts), which uploads to Cloudflare R2 whenever it's
//    configured — a different host entirely (`R2_PUBLIC_URL`), falling back
//    to the same Supabase bucket only when R2 isn't set up. Both hosts need
//    a remotePattern, or `next/image` silently fails to render whichever one
//    is missing (this is what broke blog post cover images: R2 is
//    configured in production, but only the Supabase host was allow-listed
//    here).
const supabaseHost = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
  } catch {
    return undefined;
  }
})();

const r2Host = (() => {
  try {
    return new URL(process.env.R2_PUBLIC_URL ?? "").hostname;
  } catch {
    return undefined;
  }
})();

// The production media CDN, allow-listed unconditionally. Deriving the R2
// host from `R2_PUBLIC_URL` alone is fragile: that variable is read at BUILD
// time, so a deploy where it was unset, scoped to a different environment,
// or added after the build silently ships with no R2 pattern at all — and
// every blog cover image then 400s at `/_next/image` with
// INVALID_IMAGE_OPTIMIZE_REQUEST (confirmed live on 2026-09-07: the same
// optimizer served a Supabase-hosted logo and rejected a valid PNG on
// cdn.ecomstrait.com). `*.r2.dev` covers a bucket's default public domain
// before a custom domain is attached. URLs in `store_media`/`store_posts`
// are stored absolute, so the host in the DB must always be allow-listed
// here regardless of what today's env var says.
const KNOWN_MEDIA_HOSTS = ["cdn.ecomstrait.com", "*.r2.dev"];
const mediaHosts = Array.from(new Set([...(r2Host ? [r2Host] : []), ...KNOWN_MEDIA_HOSTS]));


/**
 * Baseline browser hardening. `frame-ancestors 'self'` covers the builder's
 * own preview iframe and blocks clickjacking from anywhere else; a full
 * script-src policy is deliberately not set here (Stripe, Supabase and the
 * inline theme scripts would each need allow-listing first).
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  transpilePackages: ["@ecomstrait/ui", "@ecomstrait/auth", "@ecomstrait/db"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  images: {
    remotePatterns: [
      ...(supabaseHost
        ? [{ protocol: "https" as const, hostname: supabaseHost, pathname: "/storage/v1/object/public/**" }]
        : []),
      ...mediaHosts.map((hostname) => ({ protocol: "https" as const, hostname, pathname: "/**" })),
    ],
  },
};

export default nextConfig;
