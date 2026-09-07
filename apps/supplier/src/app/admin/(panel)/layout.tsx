import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { requireRole } from "@ecomstrait/auth/session";
import { signOutAdmin } from "@/lib/actions";
import { ToastProvider } from "@/components/app/toast";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRole("admin", "/dashboard");

  return (
    <ToastProvider>
      <div className="min-h-screen bg-ink-50/50">
        <header className="border-b border-ink-100 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
            <Link href="/admin/suppliers" className="flex items-center gap-2 text-base font-bold text-ink-950">
              <ShieldCheck className="h-5 w-5 text-ai-500" />
              EcomStrait <span className="text-ai-600">Admin</span>
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              <Link href="/admin/suppliers" className="font-medium text-ink-600 hover:text-ink-950">
                Suppliers
              </Link>
              <Link href="/admin/shopify-stores" className="font-medium text-ink-600 hover:text-ink-950">
                Shopify stores
              </Link>
              <Link href="/admin/users" className="font-medium text-ink-600 hover:text-ink-950">
                Users
              </Link>
              <form action={signOutAdmin}>
                <button
                  type="submit"
                  className="rounded-lg border border-ink-200 px-3 py-1.5 font-medium text-ink-700 hover:bg-ink-50"
                >
                  Sign out
                </button>
              </form>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </div>
    </ToastProvider>
  );
}
