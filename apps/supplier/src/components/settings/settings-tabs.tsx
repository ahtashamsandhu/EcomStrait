"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@ecomstrait/ui";

const TABS = [
  { href: "/settings/account", label: "Account" },
  { href: "/settings/business-profile", label: "Business profile" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav className="mt-5 flex gap-1 border-b border-ink-100" aria-label="Settings sections">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
              active
                ? "border-brand-500 text-ink-950"
                : "border-transparent text-ink-500 hover:border-ink-200 hover:text-ink-800",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
