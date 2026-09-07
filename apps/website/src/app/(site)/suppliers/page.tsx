import type { Metadata } from "next";
import { Section, SectionHeading } from "@/components/ui/section";
import { BenefitsGrid } from "@/components/shared/benefits-grid";
import { LeadForm } from "@/components/shared/lead-form";
import { CtaBanner } from "@/components/shared/cta-banner";
import { SuppliersHero } from "@/components/pages/suppliers-hero";
import { SupplierDashboard } from "@/components/pages/supplier-dashboard";
import { SupplierOnboarding } from "@/components/pages/supplier-onboarding";
import { PricingPlans } from "@/components/pages/pricing-plans";
import { supplierBenefits } from "@/content/process";

export const metadata: Metadata = {
  title: "For Suppliers",
  description:
    "Publish your catalog once and reach thousands of store owners. Automated orders, central inventory, and AI product enrichment for wholesale suppliers.",
};

export default function SuppliersPage() {
  return (
    <>
      <SuppliersHero />

      <Section tone="light">
        <SectionHeading
          eyebrow="Benefits"
          title="Everything a modern supplier needs"
          description="Reach, automation, and intelligence — built to help you sell more with less effort."
        />
        <div className="mt-14">
          <BenefitsGrid items={supplierBenefits} />
        </div>
      </Section>

      {/* Dashboard preview */}
      <Section tone="dark">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <SectionHeading
            invert
            align="left"
            eyebrow="Supplier Dashboard"
            title="Your whole wholesale business, one screen"
            description="Track revenue, orders, top products, and live inventory. Let AI surface what to restock and what's trending."
          />
          <SupplierDashboard />
        </div>
      </Section>

      {/* Onboarding */}
      <Section tone="light">
        <SectionHeading eyebrow="Onboarding" title="Get verified in four steps" />
        <SupplierOnboarding />
      </Section>

      <PricingPlans audience="suppliers" />

      {/* Registration */}
      <Section tone="dark" id="register">
        <div className="grid items-start gap-12 lg:grid-cols-2">
          <SectionHeading
            invert
            align="left"
            eyebrow="Register"
            title="Apply to become a verified supplier"
            description="Tell us about your business and we'll get you set up. The first 100 suppliers receive premium access."
          />
          <LeadForm
            formName="supplier-application"
            submitLabel="Submit Application"
            successTitle="Application received!"
            successMessage="Our supplier team will review your details and reach out within a few business days."
            fields={[
              { name: "company", label: "Company name", required: true, full: true },
              { name: "contact", label: "Contact name", required: true },
              { name: "email", label: "Email", type: "email", required: true },
              { name: "phone", label: "Phone", type: "tel" },
              { name: "category", label: "Product category", type: "select", required: true, options: ["Fashion", "Cosmetics", "Electronics", "Furniture", "Grocery", "Medical", "Sports", "Other"] },
              { name: "catalog", label: "Approx. catalog size", type: "select", options: ["1–50", "50–500", "500–5,000", "5,000+"] },
              { name: "about", label: "Tell us about your business", type: "textarea", full: true, placeholder: "What do you make or distribute?" },
            ]}
          />
        </div>
      </Section>

      <CtaBanner />
    </>
  );
}
