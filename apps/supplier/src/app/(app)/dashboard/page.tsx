import Link from "next/link";
import type { Metadata } from "next";
import { Suspense } from "react";
import {
  ArrowRight,
  ClipboardList,
  AlertTriangle,
  Boxes,
  ShieldCheck,
  Clock,
  BadgeCheck,
  Check,
  Circle,
} from "lucide-react";
import { createClient } from "@ecomstrait/auth/server";
import { getMySupplier } from "@/lib/supplier-context";
import type { SupplierVerification } from "@ecomstrait/db/types";
import { RETURN_CHECKLIST } from "@/lib/onboarding";
import { OnboardingToast } from "@/components/onboarding/onboarding-toast";

export const metadata: Metadata = { title: "Dashboard" };

const LEVELS: { key: keyof SupplierVerification; label: string }[] = [
  { key: "email_verified_at", label: "Email verified" },
  { key: "phone_verified_at", label: "Phone verified" },
  { key: "documents_verified_at", label: "Documents verified" },
  { key: "manual_reviewed_at", label: "Manual review" },
  { key: "badge_granted_at", label: "Verified badge granted" },
];

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const name = user?.user_metadata?.full_name?.split(" ")[0];

  const my = await getMySupplier();
  const { data: supplier } = my
    ? await supabase
        .from("suppliers")
        .select("id, status, business_name, quality_score, return_reasons, return_note")
        .eq("id", my.supplierId)
        .maybeSingle()
    : { data: null };

  const { data: verification } = supplier
    ? await supabase
        .from("supplier_verification")
        .select("*")
        .eq("supplier_id", supplier.id)
        .maybeSingle()
    : { data: null };

  const { data: products } = supplier
    ? await supabase
        .from("products")
        .select("status, stock, reserved, low_stock_threshold")
        .eq("supplier_id", supplier.id)
    : { data: [] };

  const productList = products ?? [];
  const publishedCount = productList.filter((p) => p.status === "published").length;
  const lowStockCount = productList.filter(
    (p) => p.stock - p.reserved <= p.low_stock_threshold,
  ).length;

  const { count: openRequests } = supplier
    ? await supabase
        .from("product_requests")
        .select("id", { count: "exact", head: true })
        .eq("supplier_id", supplier.id)
        .in("status", ["new", "proposed"])
    : { count: 0 };

  const status = supplier?.status ?? "pending";
  const completed = verification
    ? LEVELS.filter((l) => verification[l.key]).length
    : 0;
  const returnKeys = new Set(supplier?.return_reasons ?? []);
  const returnReasons = RETURN_CHECKLIST.filter((item) => returnKeys.has(item.key)).map((item) => item.label);
  const returnNote = supplier?.return_note ?? null;

  const widgets = [
    { label: "Open requests", value: String(openRequests ?? 0), icon: ClipboardList },
    { label: "Published products", value: String(publishedCount), icon: Boxes },
    { label: "Low stock", value: String(lowStockCount), icon: AlertTriangle },
    { label: "Quality score", value: supplier?.quality_score != null ? String(supplier.quality_score) : "—", icon: ShieldCheck },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <Suspense fallback={null}>
        <OnboardingToast />
      </Suspense>
      <h1 className="text-2xl font-bold text-ink-950">Welcome{name ? `, ${name}` : ""} 👋</h1>
      <p className="mt-1 text-sm text-ink-500">
        {supplier?.business_name
          ? `Managing ${supplier.business_name}.`
          : "Let's get your supplier account set up."}
      </p>

      {status === "pending" && (returnReasons.length > 0 || returnNote) ? (
        <Banner
          tone="amber"
          icon={<AlertTriangle className="h-5 w-5" />}
          title="Your application was returned for edits"
          body="An admin flagged a few things to fix before your application can move forward."
          cta={{ href: "/onboarding", label: "Continue editing" }}
        >
          {returnReasons.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1.5">
              {returnReasons.map((label) => (
                <li key={label} className="flex items-start gap-2 text-sm text-ink-700">
                  <Circle className="mt-1 h-1.5 w-1.5 shrink-0 fill-current text-amber-500" />
                  {label}
                </li>
              ))}
            </ul>
          )}
          {returnNote && (
            <p className="mt-3 rounded-lg bg-white/60 p-3 text-sm text-ink-700">{returnNote}</p>
          )}
        </Banner>
      ) : (
        status === "pending" && (
          <Banner
            tone="brand"
            title="Finish setting up your business"
            body="Complete the 5-step onboarding to get verified and start publishing products."
            cta={{ href: "/onboarding", label: "Start onboarding" }}
          />
        )
      )}
      {status === "in_review" && (
        <Banner
          tone="amber"
          icon={<Clock className="h-5 w-5" />}
          title="Application under review"
          body="Thanks! Our team is verifying your documents. You'll get an email once you're approved — usually within a few business days."
        />
      )}
      {status === "approved" && (
        <Banner
          tone="brand"
          icon={<BadgeCheck className="h-5 w-5" />}
          title="You're a verified supplier"
          body="Your account is approved. Start adding products to your catalog."
          cta={{ href: "/catalog", label: "Add products" }}
        />
      )}
      {status === "rejected" && (
        <Banner
          tone="red"
          title="Verification needs attention"
          body="We couldn't verify your application. Please review your details or contact support."
          cta={{ href: "/onboarding", label: "Review details" }}
        />
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {widgets.map((w) => (
          <div key={w.label} className="rounded-2xl border border-ink-100 bg-white p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink-400">{w.label}</span>
              <w.icon className="h-4 w-4 text-ink-300" />
            </div>
            <p className="mt-2 text-2xl font-bold text-ink-950">{w.value}</p>
          </div>
        ))}
      </div>

      {/* Verification progress (real data) */}
      {supplier && (
        <div className="mt-6 rounded-2xl border border-ink-100 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-950">Verification progress</h2>
            <span className="text-xs font-medium text-ink-400">{completed}/5</span>
          </div>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
            <div
              className="h-full rounded-full bg-brand-500 transition-all"
              style={{ width: `${(completed / LEVELS.length) * 100}%` }}
            />
          </div>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {LEVELS.map((l) => {
              const done = Boolean(verification?.[l.key]);
              return (
                <li key={l.key} className="flex items-center gap-2 text-sm">
                  {done ? (
                    <Check className="h-4 w-4 text-brand-600" />
                  ) : (
                    <Circle className="h-4 w-4 text-ink-300" />
                  )}
                  <span className={done ? "text-ink-800" : "text-ink-400"}>{l.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Banner({
  tone,
  title,
  body,
  cta,
  icon,
  children,
}: {
  tone: "brand" | "amber" | "red";
  title: string;
  body: string;
  cta?: { href: string; label: string };
  icon?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const tones = {
    brand: "border-brand-100 bg-brand-50/60",
    amber: "border-amber-200 bg-amber-50",
    red: "border-red-200 bg-red-50",
  } as const;
  return (
    <div
      className={`mt-6 flex flex-col items-start justify-between gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center ${tones[tone]}`}
    >
      <div className="flex items-start gap-3">
        {icon && <span className="mt-0.5 text-ink-600">{icon}</span>}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-950">{title}</p>
          <p className="text-sm text-ink-500">{body}</p>
          {children}
        </div>
      </div>
      {cta && (
        <Link
          href={cta.href}
          className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-600"
        >
          {cta.label} <ArrowRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}
