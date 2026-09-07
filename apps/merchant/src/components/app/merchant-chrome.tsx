"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Search,
  // LayoutGrid, // only used by the hidden Gallery nav entry below
  Sparkles,
  Bot,
  PackageOpen,
  Store,
  ShoppingBag,
  TrendingUp,
  CreditCard,
  Wallet,
  Settings,
  Menu,
  X,
  ChevronDown,
} from "lucide-react";
import { cn, useClickOutside } from "@ecomstrait/ui";
import { BetaBadge } from "@ecomstrait/ui/beta";
import { signOut } from "@/lib/actions";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/find-suppliers", label: "Find Products", icon: Search },
  // Gallery hidden while we offer a single premium theme — restore this row
  // when there's more than one to browse. See app/(app)/gallery/page.tsx.
  // { href: "/gallery", label: "Store Gallery", icon: LayoutGrid },
  { href: "/builder", label: "Store Builder", icon: Sparkles },
  { href: "/inventory", label: "Selected Inventory", icon: PackageOpen },
  { href: "/stores", label: "Stores", icon: Store },
  { href: "/orders", label: "Orders", icon: ShoppingBag },
  { href: "/sales", label: "Sales", icon: TrendingUp },
  { href: "/wallet", label: "Wallet", icon: Wallet },
  { href: "/cofounder", label: "Co-Founder", icon: Bot },
  { href: "/billing", label: "Billing", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: Settings },
];

function Brand() {
  return (
    <Link href="/dashboard" className="text-base font-bold tracking-tight text-ink-950">
      Ecom<span className="text-brand-600">Strait</span>
      <BetaBadge className="ml-1.5" />
    </Link>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 flex-col gap-1 px-3">
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition",
              active ? "bg-ink-950 text-white" : "text-ink-600 hover:bg-ink-50 hover:text-ink-950",
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function MerchantChrome({
  email,
  fullName,
  avatarUrl,
  children,
}: {
  email: string;
  fullName?: string | null;
  avatarUrl?: string | null;
  children: React.ReactNode;
}) {
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useClickOutside<HTMLDivElement>(menu, () => setMenu(false));

  return (
    <div className="flex min-h-screen bg-ink-50/50">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-100 bg-white lg:flex">
        <div className="px-6 py-5">
          <Brand />
        </div>
        <NavLinks />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-950/40" onClick={() => setDrawer(false)} />
          <div className="absolute left-0 top-0 flex h-full w-64 flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between px-6 py-5">
              <Brand />
              <button aria-label="Close menu" onClick={() => setDrawer(false)}>
                <X className="h-5 w-5 text-ink-500" />
              </button>
            </div>
            <NavLinks onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-ink-100 bg-white px-4 py-3 sm:px-6">
          <button aria-label="Open menu" className="text-ink-600 lg:hidden" onClick={() => setDrawer(true)}>
            <Menu className="h-5 w-5" />
          </button>
          <div className="relative ml-auto" ref={menuRef}>
            <button
              onClick={() => setMenu((m) => !m)}
              className="flex items-center gap-2 rounded-lg py-1.5 pl-2 pr-1.5 text-left hover:bg-ink-100"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-brand-500 text-sm font-bold text-white">
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  (fullName || email)[0]?.toUpperCase()
                )}
              </span>
              <span className="hidden max-w-[12rem] flex-col text-left sm:flex">
                <span className="truncate text-sm font-medium text-ink-900">{fullName || email}</span>
                {fullName && <span className="truncate text-xs text-ink-400">{email}</span>}
              </span>
              <ChevronDown className="h-4 w-4 text-ink-400" />
            </button>
            {menu && (
              <div className="absolute right-0 top-12 z-30 w-48 rounded-xl border border-ink-100 bg-white p-1.5 shadow-lg">
                <Link href="/settings" onClick={() => setMenu(false)} className="block rounded-lg px-3 py-2 text-sm text-ink-700 hover:bg-ink-50">
                  Settings
                </Link>
                <Link href="/billing" onClick={() => setMenu(false)} className="block rounded-lg px-3 py-2 text-sm text-ink-700 hover:bg-ink-50">
                  Billing
                </Link>
                <form action={signOut}>
                  <button type="submit" className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50">
                    Sign out
                  </button>
                </form>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
