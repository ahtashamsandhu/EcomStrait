/**
 * Validate a post-auth destination taken from the URL (`?next=` on the auth
 * routes, `?redirect=` on the login form).
 *
 * Only a same-origin absolute path is accepted. Everything else falls back:
 *   - `https://evil.example` : an absolute URL, hard navigation off-site
 *   - `//evil.example`       : protocol-relative, same effect
 *   - `@evil.example`        : `${origin}@evil.example` parses as userinfo@host
 *   - `.evil.example`        : `${origin}.evil.example` is another host
 *   - `/\\evil.example`      : some browsers normalise a backslash to a slash
 * A recovery link lands on these routes with a freshly minted session, so an
 * open redirect here is a phishing kit, not a nuisance.
 *
 * Pure and dependency-free so it is safe to import from client components.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  const value = raw.trim();
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  // Control characters or whitespace inside a path are never legitimate.
  if (/[\u0000-\u0020\u007f]/.test(value)) return fallback;
  try {
    // Resolve against a fixed origin; the result must stay on it.
    const url = new URL(value, "https://placeholder.invalid");
    if (url.origin !== "https://placeholder.invalid") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
