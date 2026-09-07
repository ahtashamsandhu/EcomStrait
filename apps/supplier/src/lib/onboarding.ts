import type { DocumentType } from "@ecomstrait/db/types";

/** The editable onboarding fields (mirrors the suppliers row). */
export type SupplierForm = {
  business_name: string;
  business_type: string;
  contact_person: string;
  phone: string;
  country: string;
  city: string;
  website: string;
  years_in_business: string;
  product_categories: string[];
  number_of_products: string;
  manufacturing_type: string;
  description: string;
  estimated_inventory_size: string;
  average_lead_time: string;
  shipping_regions: string[];
  min_order_quantity: string;
};

export const EMPTY_FORM: SupplierForm = {
  business_name: "",
  business_type: "",
  contact_person: "",
  phone: "",
  country: "",
  city: "",
  website: "",
  years_in_business: "",
  product_categories: [],
  number_of_products: "",
  manufacturing_type: "",
  description: "",
  estimated_inventory_size: "",
  average_lead_time: "",
  shipping_regions: [],
  min_order_quantity: "",
};

export type FieldDef = {
  name: keyof SupplierForm;
  label: string;
  type: "text" | "textarea" | "select" | "multiselect";
  required?: boolean;
  options?: string[];
  placeholder?: string;
  full?: boolean;
};

const BUSINESS_TYPES = ["Manufacturer", "Wholesaler", "Distributor", "Brand", "Trading company", "Other"];
const CATEGORIES = ["Fashion", "Cosmetics", "Electronics", "Furniture", "Grocery", "Medical", "Sports", "Home", "Toys", "Automotive"];
const YEARS = ["< 1 year", "1–3 years", "3–5 years", "5–10 years", "10+ years"];
const PRODUCT_COUNTS = ["1–50", "50–500", "500–5,000", "5,000+"];
const MANUFACTURING = ["Manufacturer", "Reseller", "Both"];
const INVENTORY_SIZES = ["Small (< 1k units)", "Medium (1k–10k)", "Large (10k–100k)", "Enterprise (100k+)"];
const LEAD_TIMES = ["1–3 days", "3–7 days", "1–2 weeks", "2–4 weeks", "4+ weeks"];
const SHIPPING_REGIONS = ["North America", "Europe", "Middle East", "Asia", "Africa", "South America", "Oceania", "Worldwide"];
const MOQ = ["No minimum", "1–10", "10–50", "50–100", "100+"];

export const STEP1_FIELDS: FieldDef[] = [
  { name: "business_name", label: "Business name", type: "text", required: true, full: true },
  { name: "business_type", label: "Business type", type: "select", required: true, options: BUSINESS_TYPES },
  { name: "contact_person", label: "Person name", type: "text", required: true },
  { name: "phone", label: "Phone number", type: "text", required: true, placeholder: "+1 555 000 0000" },
  { name: "country", label: "Country", type: "text", required: true },
  { name: "city", label: "City", type: "text", required: true },
  { name: "website", label: "Website (optional)", type: "text", placeholder: "https://", full: true },
];

export const STEP2_FIELDS: FieldDef[] = [
  { name: "years_in_business", label: "Years in business", type: "select", required: true, options: YEARS },
  { name: "number_of_products", label: "Number of products", type: "select", required: true, options: PRODUCT_COUNTS },
  { name: "manufacturing_type", label: "Manufacturer or reseller", type: "select", required: true, options: MANUFACTURING },
  { name: "product_categories", label: "Product categories", type: "multiselect", required: true, options: CATEGORIES, full: true },
  { name: "description", label: "Business description", type: "textarea", required: true, full: true, placeholder: "What do you make or distribute?" },
];

export const STEP4_FIELDS: FieldDef[] = [
  { name: "estimated_inventory_size", label: "Estimated inventory size", type: "select", required: true, options: INVENTORY_SIZES },
  { name: "average_lead_time", label: "Average lead time", type: "select", required: true, options: LEAD_TIMES },
  { name: "min_order_quantity", label: "Minimum order quantity", type: "select", required: true, options: MOQ },
  { name: "shipping_regions", label: "Shipping regions", type: "multiselect", required: true, options: SHIPPING_REGIONS, full: true },
];

export const DOCUMENTS: { type: DocumentType; label: string; required: boolean }[] = [
  { type: "business_registration", label: "Business registration certificate", required: true },
  { type: "tax_registration", label: "Tax registration (optional)", required: false },
  { type: "national_id", label: "National ID / Passport", required: true },
  { type: "company_logo", label: "Company logo", required: false },
  { type: "address_proof", label: "Business address proof", required: true },
];

export const STEPS = [
  { n: 1, title: "Business info" },
  { n: 2, title: "Business details" },
  { n: 3, title: "Documents" },
  { n: 4, title: "Products" },
  { n: 5, title: "Review" },
] as const;

/**
 * What an admin can flag when returning an application for edits — one
 * shared list so the admin's checklist form and what the supplier sees
 * (dashboard banner, onboarding wizard banner) never drift into three
 * independently-typed copies of the same items. Labels mirror the wizard's
 * own step/field-group names above so both sides recognize them.
 */
export const RETURN_CHECKLIST = [
  { key: "business_info", label: "Business information (name, type, person name, phone, location, website)" },
  { key: "business_details", label: "Business details (experience, categories, description)" },
  { key: "doc_business_registration", label: "Business registration document" },
  { key: "doc_tax_registration", label: "Tax registration document" },
  { key: "doc_national_id", label: "National ID / passport document" },
  { key: "doc_company_logo", label: "Company logo" },
  { key: "doc_address_proof", label: "Business address proof document" },
  { key: "product_info", label: "Product information (inventory size, lead time, shipping regions)" },
] as const;

/** Fields that must be non-empty for a given step to advance. */
export function stepFields(step: number): FieldDef[] {
  if (step === 1) return STEP1_FIELDS;
  if (step === 2) return STEP2_FIELDS;
  if (step === 4) return STEP4_FIELDS;
  return [];
}
