"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Boxes,
  Store,
  Warehouse,
  ClipboardList,
  Package,
  BarChart3,
  Wallet,
  Sparkles,
  CreditCard,
  Settings,
  Menu,
  X,
  Bell,
  ChevronDown,
} from "lucide-react";
import { cn, useClickOutside } from "@ecomstrait/ui";
import { BetaBadge } from "@ecomstrait/ui/beta";
import { signOut } from "@/lib/actions";
import type { Notification } from "@/lib/notifications";
import { ToastProvider } from "@/components/app/toast";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/catalog", label: "Catalog", icon: Boxes },
  { href: "/inventory", label: "Inventory", icon: Warehouse },
  { href: "/requests", label: "Requests", icon: ClipboardList },
  { href: "/listings", label: "Listing requests", icon: Store },
  { href: "/orders", label: "Orders", icon: Package },
  { href: "/wallet", label: "Wallet", icon: Wallet },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/cofounder", label: "Co-Founder", icon: Sparkles },
  { href: "/billing", label: "Billing", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: Settings },
];

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
              active
                ? "bg-ink-950 text-white"
                : "text-ink-600 hover:bg-ink-50 hover:text-ink-950",
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

function Brand() {
  return (
    <Link
      href="/dashboard"
      className="inline-flex items-center gap-1.5 text-base font-bold tracking-tight text-ink-950"
    >
      EcomStrait <span className="text-brand-600">Suppliers</span>
      <BetaBadge />
    </Link>
  );
}

export function AppChrome({
  email,
  role,
  fullName,
  avatarUrl,
  notifications = [],
  children,
}: {
  email: string;
  role: string;
  fullName?: string | null;
  avatarUrl?: string | null;
  notifications?: Notification[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [bell, setBell] = useState(false);

  // Close any open dropdowns/drawer when navigating to a different tab.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setBell(false);
    setMenu(false);
    setDrawer(false);
  }

  // Same for a click anywhere outside the open dropdown itself.
  const bellRef = useClickOutside<HTMLDivElement>(bell, () => setBell(false));
  const menuRef = useClickOutside<HTMLDivElement>(menu, () => setMenu(false));

  return (
    <ToastProvider>
      <div className="flex min-h-screen bg-ink-50/50">
        {/* Desktop sidebar */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-100 bg-white lg:flex">
          <div className="px-6 py-5">
            <Brand />
          </div>
          <NavLinks />
        </aside>

        {/* Mobile drawer */}
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
            <button
              aria-label="Open menu"
              className="text-ink-600 lg:hidden"
              onClick={() => setDrawer(true)}
            >
              <Menu className="h-5 w-5" />
            </button>

            <div className="ml-auto flex items-center gap-2">
              {/* Notifications */}
              <div className="relative" ref={bellRef}>
                <button
                  aria-label="Notifications"
                  onClick={() => {
                    setBell((b) => !b);
                    setMenu(false);
                  }}
                  className="relative grid h-9 w-9 place-items-center rounded-lg text-ink-500 hover:bg-ink-100"
                >
                  <Bell className="h-5 w-5" />
                  {notifications.length > 0 && (
                    <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                      {notifications.length}
                    </span>
                  )}
                </button>
                {bell && (
                  <div className="absolute right-0 top-11 z-30 w-72 overflow-hidden rounded-xl border border-ink-100 bg-white shadow-lg">
                    {notifications.length === 0 ? (
                      <div className="p-4 text-center">
                        <p className="text-sm font-medium text-ink-900">You&apos;re all caught up</p>
                        <p className="mt-1 text-xs text-ink-400">Requests and updates will show up here.</p>
                      </div>
                    ) : (
                      <ul className="divide-y divide-ink-50">
                        {notifications.map((n) => (
                          <li key={n.id}>
                            <Link
                              href={n.href}
                              onClick={() => setBell(false)}
                              className="block px-4 py-3 hover:bg-ink-50"
                            >
                              <p className="text-sm font-medium text-ink-900">{n.title}</p>
                              <p className="text-xs text-ink-400">{n.body}</p>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              {/* Account menu */}
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => {
                    setMenu((m) => !m);
                    setBell(false);
                  }}
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
                  <span className="hidden sm:block">
                    <span className="block max-w-[10rem] truncate text-sm font-medium text-ink-900">
                      {fullName || email}
                    </span>
                    <span className="block text-xs capitalize text-ink-400">{role}</span>
                  </span>
                  <ChevronDown className="h-4 w-4 text-ink-400" />
                </button>
                {menu && (
                  <div className="absolute right-0 top-12 z-30 w-52 rounded-xl border border-ink-100 bg-white p-1.5 shadow-lg">
                    <Link
                      href="/settings/account"
                      onClick={() => setMenu(false)}
                      className="block rounded-lg px-3 py-2 text-sm text-ink-700 hover:bg-ink-50"
                    >
                      Account settings
                    </Link>
                    <Link
                      href="/settings/business-profile"
                      onClick={() => setMenu(false)}
                      className="block rounded-lg px-3 py-2 text-sm text-ink-700 hover:bg-ink-50"
                    >
                      Business profile
                    </Link>
                    <Link
                      href="/help"
                      onClick={() => setMenu(false)}
                      className="block rounded-lg px-3 py-2 text-sm text-ink-700 hover:bg-ink-50"
                    >
                      Help &amp; support
                    </Link>
                    <form action={signOut}>
                      <button
                        type="submit"
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                      >
                        Sign out
                      </button>
                    </form>
                  </div>
                )}
              </div>
            </div>
          </header>

          <main className="flex-1 p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
