import Link from "next/link";
import { requireUser } from "@ecomstrait/auth/session";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUser();
  return (
    <div className="min-h-screen bg-ink-50/50">
      <header className="border-b border-ink-100 bg-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-6 py-4">
          <Link href="/dashboard" className="text-base font-bold tracking-tight text-ink-950">
            EcomStrait <span className="text-brand-600">Suppliers</span>
          </Link>
          <Link href="/dashboard" className="text-sm font-medium text-ink-500 hover:text-ink-800">
            Back to dashboard
          </Link>
        </div>
      </header>
      <main className="px-6 py-10">{children}</main>
    </div>
  );
}
