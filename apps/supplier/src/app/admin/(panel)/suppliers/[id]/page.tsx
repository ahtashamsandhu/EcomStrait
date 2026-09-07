import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, Check, Circle, FileText } from "lucide-react";
import { createAdminClient } from "@ecomstrait/db/admin";
import type { SupplierVerification } from "@ecomstrait/db/types";
import { DOCUMENTS } from "@/lib/onboarding";
import { AdminActions } from "@/components/admin/admin-actions";
import { PhoneVerifyToggle } from "@/components/admin/phone-verify-toggle";
import { SampleRequestForm } from "@/components/admin/sample-request-form";

export const metadata: Metadata = { title: "Review supplier — Admin" };

const LEVELS: { key: keyof SupplierVerification; label: string }[] = [
  { key: "email_verified_at", label: "Email verified" },
  { key: "phone_verified_at", label: "Phone verified" },
  { key: "documents_verified_at", label: "Documents verified" },
  { key: "manual_reviewed_at", label: "Manual review" },
  { key: "badge_granted_at", label: "Verified badge" },
];

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col border-b border-ink-50 py-2.5 last:border-0 sm:flex-row sm:justify-between">
      <dt className="text-sm text-ink-500">{label}</dt>
      <dd className="text-sm font-medium text-ink-900">{value || "—"}</dd>
    </div>
  );
}

export default async function AdminSupplierDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const client = createAdminClient();
  if (!client) return <p className="text-sm text-red-600">Server is not configured.</p>;

  const { data: supplier } = await client.from("suppliers").select("*").eq("id", id).maybeSingle();
  if (!supplier) notFound();

  const { data: verification } = await client
    .from("supplier_verification")
    .select("*")
    .eq("supplier_id", id)
    .maybeSingle();

  const { data: documents } = await client
    .from("supplier_documents")
    .select("*")
    .eq("supplier_id", id);

  const { data: products } = await client
    .from("products")
    .select("id, title")
    .eq("supplier_id", id)
    .order("title");

  const docs = await Promise.all(
    (documents ?? []).map(async (d) => {
      const { data } = await client.storage
        .from("supplier-documents")
        .createSignedUrl(d.storage_path, 3600);
      return { ...d, url: data?.signedUrl ?? null };
    }),
  );
  const label = (t: string) => DOCUMENTS.find((x) => x.type === t)?.label ?? t;

  return (
    <div>
      <Link href="/admin/suppliers" className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-4 w-4" /> Suppliers
      </Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-ink-950">
          {supplier.business_name || "Unnamed supplier"}
        </h1>
        <span className="rounded-full bg-ink-100 px-3 py-1 text-xs font-semibold capitalize text-ink-600">
          {supplier.status.replace("_", " ")}
        </span>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {/* Business */}
          <section className="rounded-2xl border border-ink-100 bg-white p-5">
            <h2 className="text-sm font-semibold text-ink-950">Business</h2>
            <dl className="mt-2">
              <Row label="Business type" value={supplier.business_type ?? ""} />
              <Row label="Contact" value={supplier.contact_person ?? ""} />
              <Row label="Phone" value={supplier.phone ?? ""} />
              <Row label="Location" value={[supplier.city, supplier.country].filter(Boolean).join(", ")} />
              <Row label="Website" value={supplier.website ?? ""} />
              <Row label="Years in business" value={supplier.years_in_business ?? ""} />
              <Row label="Type" value={supplier.manufacturing_type ?? ""} />
              <Row label="Categories" value={(supplier.product_categories ?? []).join(", ")} />
              <Row label="Description" value={supplier.description ?? ""} />
            </dl>
          </section>

          {/* Documents */}
          <section className="rounded-2xl border border-ink-100 bg-white p-5">
            <h2 className="text-sm font-semibold text-ink-950">Documents</h2>
            {docs.length === 0 ? (
              <p className="mt-2 text-sm text-ink-400">No documents uploaded.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {docs.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-4 py-2.5">
                    <span className="flex items-center gap-2 text-sm text-ink-800">
                      <FileText className="h-4 w-4 text-ink-400" /> {label(d.type)}
                    </span>
                    {d.url ? (
                      <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-ai-600 hover:underline">
                        View
                      </a>
                    ) : (
                      <span className="text-xs text-ink-400">unavailable</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Sidebar: decision + verification */}
        <div className="flex flex-col gap-6">
          <section className="rounded-2xl border border-ink-100 bg-white p-5">
            <h2 className="text-sm font-semibold text-ink-950">Decision</h2>
            <p className="mb-4 mt-1 text-xs text-ink-400">
              Approving grants the verified badge and unlocks publishing.
            </p>
            <AdminActions id={supplier.id} status={supplier.status} />
          </section>

          <section className="rounded-2xl border border-ink-100 bg-white p-5">
            <h2 className="text-sm font-semibold text-ink-950">Testing</h2>
            <p className="mb-3 mt-1 text-xs text-ink-400">
              Seed a store-owner request — with real contact and shipping details you enter —
              to preview the supplier&apos;s inbox (until the merchant app generates these for
              real).
            </p>
            <SampleRequestForm supplierId={supplier.id} products={products ?? []} />
          </section>

          <section className="rounded-2xl border border-ink-100 bg-white p-5">
            <h2 className="text-sm font-semibold text-ink-950">Verification</h2>
            <ul className="mt-3 flex flex-col gap-2">
              {LEVELS.map((l) => {
                const done = Boolean(verification?.[l.key]);
                // Phone is the one level an admin toggles manually.
                if (l.key === "phone_verified_at") {
                  return (
                    <li key={l.key}>
                      <PhoneVerifyToggle id={supplier.id} verified={done} phone={supplier.phone} />
                    </li>
                  );
                }
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
          </section>
        </div>
      </div>
    </div>
  );
}
