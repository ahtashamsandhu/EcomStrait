import "server-only";

/**
 * Product enrichment for suppliers — same posture as the website's EcomAI
 * engine: the "workhorse" role via the AI gateway (`@ecomstrait/ai`) when
 * configured, otherwise a deterministic template. Server-only. Output is a
 * suggestion the supplier can edit/accept.
 *
 * Goes through the gateway — this file never names a vendor or a model. See
 * `Docs/AI-Native-Migration-Plan.md`.
 */

import { chat, isGatewayConfigured } from "@ecomstrait/ai";

export type EnrichInput = {
  title: string;
  category?: string;
  wholesalePrice?: number;
  /** Supplier-set product facts (products.material / sizes / fit_note) —
   *  the only source the model may state a material or size from. */
  material?: string;
  sizes?: string;
  fitNote?: string;
  /** The supplier's own draft description, if they typed one — kept as
   *  facts to preserve, not text to discard. */
  description?: string;
  /** Retail prices of other published products in the same category
   *  (looked up by the caller, never by the form) — market context for
   *  the suggested price. */
  comparableRetailPrices?: number[];
  /** Typical retail ÷ wholesale multiple across those comparables, when
   *  both prices were set — an aggregate only, never one supplier's number. */
  comparableRetailMultiple?: number | null;
};

export type Enrichment = {
  description: string;
  seoTitle: string;
  seoDescription: string;
  suggestedRetailPrice: number | null;
  /** One clause on why the suggested retail is what it is (margin over
   *  wholesale, comparables) — for the supplier, not for a storefront. */
  pricingNote: string;
  source: "groq" | "preset";
  /** Actual tokens spent on this call (0 for the deterministic fallback) —
   *  the caller records this against the supplier's daily AI-token usage. */
  tokensUsed: number;
};

/** Target retail = wholesale × this — the middle of the 1.7–2.5× (40–60%
 *  margin) band the prompt asks the model to price in. */
const PRESET_RETAIL_MULTIPLE = 2;
const SEO_TITLE_MAX = 60;
const SEO_DESCRIPTION_MAX = 155;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

function presetEnrichment(input: EnrichInput): Enrichment {
  const cat = input.category?.trim() || "";
  const catLower = cat.toLowerCase() || "product";
  const hasWholesale = typeof input.wholesalePrice === "number" && input.wholesalePrice > 0;
  const retail = hasWholesale ? round2((input.wholesalePrice as number) * PRESET_RETAIL_MULTIPLE) : null;
  // Only facts the supplier actually gave — the preset must be as honest as
  // the model is told to be.
  const facts = [
    input.material?.trim() ? `Made from ${input.material.trim()}.` : null,
    input.sizes?.trim() ? `Available in sizes ${input.sizes.trim()}.` : null,
    input.fitNote?.trim() ? input.fitNote.trim().replace(/\.?$/, ".") : null,
  ].filter(Boolean);
  const description =
    input.description?.trim() ||
    [`${input.title} — a well-made ${catLower} ready to ship.`, ...facts, `A dependable pick for everyday use.`].join(
      " ",
    );
  const keyAttr = input.material?.trim() || cat;
  return {
    description,
    seoTitle: clamp(keyAttr ? `${input.title} – ${keyAttr}` : input.title, SEO_TITLE_MAX),
    seoDescription: clamp(
      `Shop ${input.title}${cat ? ` in ${catLower}` : ""}${
        input.material?.trim() ? `, made from ${input.material.trim()}` : ""
      }. In stock and ready to ship — order yours today.`,
      SEO_DESCRIPTION_MAX,
    ),
    suggestedRetailPrice: retail,
    pricingNote: hasWholesale
      ? `${PRESET_RETAIL_MULTIPLE}× wholesale — a ${Math.round((1 - 1 / PRESET_RETAIL_MULTIPLE) * 100)}% retail margin.`
      : "No wholesale price given, so no retail suggestion.",
    source: "preset",
    tokensUsed: 0,
  };
}

const SYSTEM_PROMPT = [
  "You are EcomAI, helping a wholesale supplier list a product on a B2B marketplace. Merchants",
  "resell it on their own consumer storefronts, so the description and SEO fields you write are",
  "shown to RETAIL shoppers on a merchant's product page — write for that shopper, never for the",
  "wholesale buyer. Never use the words \"wholesale\", \"bulk\", \"resale\" or \"margin\" in the copy.",
  "Write concise, honest, conversion-friendly copy. No hype, no emojis.",
  "Never state a material, size, certification, origin, warranty, spec, or measurement that isn't",
  "given in the input — not even one the title strongly implies. If the input gives no material,",
  "write around it; a wrong \"genuine leather\" is worse than no material at all. If the supplier's",
  "own draft description is given, keep every fact in it and improve the writing, don't replace",
  "the facts.",
  "Pricing: suggestedRetailPrice MUST be above the wholesale price. Aim for a 40-60% retail margin",
  "(retail ≈ 1.7-2.5× wholesale). If comparable retail prices on the platform are given and they",
  "clearly sit outside that band, price toward the comparables instead and say so in pricingNote.",
  "If no wholesale price is given, return 0.",
  "SEO: seoTitle is \"Product Title – key attribute\" (the attribute drawn from the input: material,",
  "category, size range), at most 60 characters, written for a retail shopper. seoDescription is",
  "120-155 characters: the product's main benefit for the shopper, then a short call to action.",
  "Respond with ONLY a JSON object using these exact keys:",
  "{",
  '  "description": string,         // 2-3 sentences, retail-facing',
  '  "seoTitle": string,            // <= 60 chars, "Title – key attribute"',
  '  "seoDescription": string,      // 120-155 chars, benefit + call to action',
  '  "suggestedRetailPrice": number, // above wholesale, 40-60% margin, or 0 if no wholesale given',
  '  "pricingNote": string          // one clause on why that price (margin, comparables)',
  "}",
].join("\n");

function buildUserMessage(input: EnrichInput): string {
  const lines = [
    `Product: ${input.title}`,
    input.category ? `Category: ${input.category}` : null,
    typeof input.wholesalePrice === "number" && input.wholesalePrice > 0
      ? `Wholesale price: $${input.wholesalePrice}`
      : null,
    input.material?.trim() ? `Material: ${input.material.trim()}` : null,
    input.sizes?.trim() ? `Sizes: ${input.sizes.trim()}` : null,
    input.fitNote?.trim() ? `Fit note: ${input.fitNote.trim()}` : null,
    input.description?.trim() ? `Supplier's own draft description: ${input.description.trim()}` : null,
    input.comparableRetailPrices?.length
      ? `Comparable retail prices on the platform (same category, other listings): ${input.comparableRetailPrices
          .map((p) => `$${p}`)
          .join(", ")}${
          input.comparableRetailMultiple ? ` — typical retail is about ${input.comparableRetailMultiple}× wholesale there` : ""
        }`
      : null,
  ];
  return lines.filter(Boolean).join("\n");
}

export async function enrichProduct(input: EnrichInput): Promise<Enrichment> {
  if (!isGatewayConfigured() || !input.title.trim()) return presetEnrichment(input);

  try {
    const { content, tokensUsed } = await chat(
      "workhorse",
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(input) },
      ],
      // reasoningEffort: "none" — a reasoning-capable model can otherwise
      // spend the entire maxTokens budget "thinking" and return empty
      // content (see @ecomstrait/ai's gateway.ts); this role is meant to be
      // fast and general-purpose, never a deep thinker.
      { temperature: 0.6, maxTokens: 500, responseFormatJson: true, timeoutMs: 8000, reasoningEffort: "none" },
    );
    const p = JSON.parse(content) as Partial<Enrichment> & { suggestedRetailPrice?: number };
    const base = presetEnrichment(input);
    // The prompt says "above wholesale"; the code guarantees it — a retail
    // at or below cost is never a suggestion a supplier should see.
    const wholesale = typeof input.wholesalePrice === "number" && input.wholesalePrice > 0 ? input.wholesalePrice : 0;
    const modelPrice =
      typeof p.suggestedRetailPrice === "number" && Number.isFinite(p.suggestedRetailPrice) && p.suggestedRetailPrice > 0
        ? round2(p.suggestedRetailPrice)
        : null;
    const priceOk = modelPrice != null && modelPrice > wholesale;
    const price = priceOk ? modelPrice : base.suggestedRetailPrice;
    const pricingNote =
      priceOk && typeof p.pricingNote === "string" && p.pricingNote.trim() ? p.pricingNote.trim() : base.pricingNote;
    return {
      description: typeof p.description === "string" && p.description.trim() ? p.description.trim() : base.description,
      seoTitle:
        typeof p.seoTitle === "string" && p.seoTitle.trim() ? clamp(p.seoTitle, SEO_TITLE_MAX) : base.seoTitle,
      seoDescription:
        typeof p.seoDescription === "string" && p.seoDescription.trim()
          ? clamp(p.seoDescription, SEO_DESCRIPTION_MAX)
          : base.seoDescription,
      suggestedRetailPrice: price,
      pricingNote,
      source: "groq",
      tokensUsed,
    };
  } catch {
    return presetEnrichment(input);
  }
}
