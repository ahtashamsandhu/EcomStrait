"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

type Props = {
  /** Placeholder describing what's searchable, e.g. "Search products, SKU…". */
  placeholder: string;
  /** Rendered on the right, typically the "1–20 of 84" summary. */
  summary?: string;
};

/**
 * URL-driven search box. Writes `?q=` (debounced) and drops `?page=` so a new
 * term always lands on page 1. Other params are preserved.
 */
export function SearchBar({ placeholder, summary }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("q") ?? "";

  const [value, setValue] = useState(current);
  const mounted = useRef(false);
  // Kept current every render instead of being a dependency below — reading
  // the latest params still works, but a navigation that has nothing to do
  // with search (e.g. clicking "Next" on pagination) no longer re-triggers
  // the write-back effect. `useSearchParams()` returns a new object on every
  // navigation, so `params` in that effect's own dependency array meant
  // paging to `?page=2` re-ran it — which, 300ms later, unconditionally
  // stripped `page` and replaced the URL, so Next visibly landed on page 2
  // and then bounced straight back to page 1.
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  });

  useEffect(() => {
    // Skip the first run so simply rendering the page doesn't navigate.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    // Nothing the user actually typed changed — this render was caused by
    // something else entirely (paging, a filter, browser back/forward).
    // Nothing to write back.
    if (value === current) return;
    const id = setTimeout(() => {
      const next = new URLSearchParams(paramsRef.current.toString());
      const term = value.trim();
      if (term) next.set("q", term);
      else next.delete("q");
      next.delete("page");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, 300);
    return () => clearTimeout(id);
    // Deliberately not exhaustive — see the comment above. Reacting to
    // `value` alone (what the user actually typed) is the fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="relative min-w-0 flex-1 sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-10 w-full rounded-xl border border-ink-200 bg-white pl-9 pr-9 text-sm outline-none focus:border-brand-400"
        />
        {value && (
          <button
            onClick={() => setValue("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-ink-400 hover:bg-ink-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {summary && <p className="text-sm text-ink-500">{summary}</p>}
    </div>
  );
}
