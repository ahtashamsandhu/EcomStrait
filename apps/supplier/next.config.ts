import type { NextConfig } from "next";


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
  // Transpile workspace packages consumed as TypeScript source.
  transpilePackages: ["@ecomstrait/ui", "@ecomstrait/auth", "@ecomstrait/db"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
