import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@ecomstrait/auth/server";
import { getMySupplier } from "@/lib/supplier-context";
import { DOCUMENTS, type SupplierForm } from "@/lib/onboarding";
import { BusinessProfileForm } from "@/components/settings/business-profile-form";

export const metadata: Metadata = { title: "Business profile" };

export default async function BusinessProfilePage() {
  const supabase = await createClient();
  const my = await getMySupplier();

  const { data: supplier } = my
    ? await supabase.from("suppliers").select("*").eq("id", my.supplierId).maybeSingle()
    : { data: null };

  if (!supplier || !my) {
    return (
      <section className="rounded-2xl border border-ink-100 bg-white p-5">
        <h2 className="text-sm font-semibold text-ink-950">Business profile</h2>
        <p className="mt-2 text-sm text-ink-500">
          You haven&apos;t started onboarding yet.{" "}
          <Link href="/onboarding" className="font-semibold text-brand-600 hover:underline">
            Get started
          </Link>
          .
        </p>
      </section>
    );
  }

  const { data: docs } = await supabase
    .from("supplier_documents")
    .select("type")
    .eq("supplier_id", supplier.id);
  const uploaded = new Set((docs ?? []).map((d) => d.type));

  const form: SupplierForm = {
    business_name: supplier.business_name ?? "",
    business_type: supplier.business_type ?? "",
    contact_person: supplier.contact_person ?? "",
    phone: supplier.phone ?? "",
    country: supplier.country ?? "",
    city: supplier.city ?? "",
    website: supplier.website ?? "",
    years_in_business: supplier.years_in_business ?? "",
    product_categories: supplier.product_categories ?? [],
    number_of_products: supplier.number_of_products ?? "",
    manufacturing_type: supplier.manufacturing_type ?? "",
    description: supplier.description ?? "",
    estimated_inventory_size: supplier.estimated_inventory_size ?? "",
    average_lead_time: supplier.average_lead_time ?? "",
    shipping_regions: supplier.shipping_regions ?? [],
    min_order_quantity: supplier.min_order_quantity ?? "",
  };

  return (
    <BusinessProfileForm
      initialForm={form}
      status={supplier.status}
      // Staff members can see the profile; only the owner edits it (the
      // suppliers row is owner-scoped in RLS anyway).
      canEdit={my.isOwner}
      documents={DOCUMENTS.map((d) => ({ label: d.label, uploaded: uploaded.has(d.type) }))}
    />
  );
}
