/**
 * Curated, **labeled/illustrative** knowledge base that grounds the EcomAI
 * builder. Each niche maps to one or more real templates in the private themes
 * bucket (sources live at <repo-root>/themes, served through /api/theme).
 * Where a niche has multiple themes, the builder picks one at random and lets
 * the visitor "change the concept" to cycle through the others.
 *
 * Every number is an EXAMPLE range for a simulated preview — never live data.
 */

export type Niche = {
  slug: string;
  label: string;
  emoji: string;
  keywords: string[];
  /** Example gross-margin % range. */
  margin: [number, number];
  /** Example verified-supplier count range. */
  suppliers: [number, number];
  /** Example monthly-revenue $ range at a modest start. */
  monthlyRevenue: [number, number];
  productIdeas: string[];
  countries: string[];
  storeSlug?: string;
  /** Theme folder names in the themes bucket. Non-empty = available in the beta. */
  themes?: string[];
};

export const niches: Niche[] = [
  {
    slug: "fashion",
    label: "Fashion",
    emoji: "🧥",
    keywords: ["fashion", "streetwear", "outfit", "style", "boutique", "menswear", "womenswear"],
    margin: [35, 50], suppliers: [30, 70], monthlyRevenue: [3000, 12000],
    productIdeas: ["Everyday Essentials Tee", "Knit Sweater", "Statement Jacket", "Layering Set"],
    countries: ["United States", "United Kingdom", "Australia"],
    storeSlug: "aurora",
    themes: ["fashion-shop1", "fashion-shop2", "fashion-shop3"],
  },
  {
    slug: "clothing",
    label: "Clothing & Apparel",
    emoji: "👕",
    keywords: ["clothing", "clothes", "apparel", "t-shirt", "tshirt", "hoodie", "jeans", "dress", "shirt"],
    margin: [35, 52], suppliers: [30, 70], monthlyRevenue: [3000, 11000],
    productIdeas: ["Organic Cotton Tee", "Relaxed Hoodie", "Straight Jean", "Everyday Shirt"],
    countries: ["United States", "United Kingdom", "Canada"],
    storeSlug: "aurora",
    themes: ["clothing-shop1", "clothing-shop2", "clothing-shop3"],
  },
  {
    slug: "shoes",
    label: "Shoes & Footwear",
    emoji: "👟",
    keywords: ["shoes", "shoe", "sneakers", "sneaker", "footwear", "trainers", "boots", "running shoes", "heels"],
    margin: [35, 50], suppliers: [20, 45], monthlyRevenue: [3000, 12000],
    productIdeas: ["Everyday Sneaker", "Trail Runner", "Leather Boot", "Court Classic"],
    countries: ["United States", "Canada", "Australia"],
    storeSlug: "forge",
    themes: ["shoes-shop1", "shoes-shop2", "shoes-shop3"],
  },
  {
    slug: "cosmetics",
    label: "Cosmetics & Beauty",
    emoji: "💄",
    keywords: ["cosmetics", "makeup", "skincare", "beauty", "serum", "cream", "lipstick", "spf"],
    margin: [42, 58], suppliers: [25, 60], monthlyRevenue: [3000, 12000],
    productIdeas: ["Radiance Serum", "Tinted SPF", "Overnight Mask", "Everyday Glow Set"],
    countries: ["United States", "United Kingdom", "Canada"],
    storeSlug: "bloom",
    themes: ["comsmatic-shop"],
  },
  {
    slug: "jewelry",
    label: "Jewelry",
    emoji: "💎",
    keywords: ["jewelry", "jewellery", "rings", "ring", "necklace", "earrings", "gold", "diamond", "bracelet"],
    margin: [45, 60], suppliers: [15, 40], monthlyRevenue: [4000, 15000],
    productIdeas: ["Solitaire Pendant", "Stacking Rings", "Huggie Hoops", "Tennis Bracelet"],
    countries: ["United States", "India", "United Kingdom"],
    storeSlug: "noir",
    themes: ["Jewellery-shop"],
  },
  {
    slug: "watches",
    label: "Watches",
    emoji: "⌚",
    keywords: ["watch", "watches", "timepiece", "smartwatch", "wristwatch"],
    margin: [38, 52], suppliers: [15, 35], monthlyRevenue: [5000, 18000],
    productIdeas: ["Smart Fitness Watch", "Minimalist Automatic", "Leather Strap Set", "Gift Box Bundle"],
    countries: ["United States", "Germany", "United Arab Emirates"],
    storeSlug: "marble",
    themes: ["watches-shop"],
  },
  {
    slug: "electronics",
    label: "Electronics & Phones",
    emoji: "📱",
    keywords: ["electronics", "smartphone", "phone", "mobile", "gadget", "gadgets", "tech", "laptop", "headphones", "audio"],
    margin: [28, 42], suppliers: [20, 50], monthlyRevenue: [4000, 16000],
    productIdeas: ["Flagship Smartphone", "Wireless Earbuds", "Fast Charger", "Smart Accessories"],
    countries: ["United States", "Germany", "Canada"],
    storeSlug: "forge",
    themes: ["smartphones-shop"],
  },
  {
    slug: "grocery",
    label: "Grocery & Gourmet",
    emoji: "🥬",
    keywords: ["grocery", "groceries", "food", "organic", "gourmet", "pantry", "produce", "vegetables", "fruits", "snacks"],
    margin: [25, 40], suppliers: [15, 40], monthlyRevenue: [3000, 10000],
    productIdeas: ["Seasonal Produce Box", "Artisan Pantry Set", "Cold-Pressed Oils", "Coffee Subscription"],
    countries: ["United States", "United Kingdom", "Canada"],
    storeSlug: "cove",
    themes: ["grocery-shop1", "grocery-shop2", "grocery-shop3"],
  },
  {
    slug: "pet",
    label: "Pet Supplies",
    emoji: "🐾",
    keywords: ["pet", "pets", "dog", "cat", "puppy", "kitten", "pet supplies", "pet food", "toys"],
    margin: [38, 52], suppliers: [18, 45], monthlyRevenue: [3000, 12000],
    productIdeas: ["Grain-Free Food", "Orthopedic Bed", "Chew Toys", "Grooming Kit"],
    countries: ["United States", "United Kingdom", "Canada"],
    storeSlug: "bloom",
    themes: ["pets-shop"],
  },
  {
    slug: "books",
    label: "Books & Stationery",
    emoji: "📚",
    keywords: ["book", "books", "bookstore", "bookshop", "stationery", "reading", "novels", "ebooks"],
    margin: [30, 45], suppliers: [12, 30], monthlyRevenue: [2000, 9000],
    productIdeas: ["Bestseller Fiction", "Signed Editions", "Kids' Boxset", "Linen Bookmarks"],
    countries: ["United States", "United Kingdom", "Canada"],
    storeSlug: "cove",
    themes: ["books-shop"],
  },
  {
    slug: "home-decor",
    label: "Home & Decor",
    emoji: "🏺",
    keywords: ["decor", "home decor", "interior", "furniture", "home", "decoration", "vase", "wall art", "lighting"],
    margin: [42, 58], suppliers: [15, 40], monthlyRevenue: [3000, 12000],
    productIdeas: ["Handwoven Throw", "Statement Lighting", "Ceramic Vase", "Framed Art Print"],
    countries: ["United States", "United Kingdom", "Australia"],
    storeSlug: "cove",
    themes: ["home-decore"],
  },
  {
    slug: "pillow",
    label: "Pillows & Bedding",
    emoji: "🛏️",
    keywords: ["pillow", "pillows", "cushion", "cushions", "bedding", "bed sheets", "duvet", "mattress"],
    margin: [40, 55], suppliers: [12, 30], monthlyRevenue: [3000, 11000],
    productIdeas: ["Memory Foam Pillow", "Linen Duvet Set", "Cushion Covers", "Weighted Blanket"],
    countries: ["United States", "United Kingdom", "Australia"],
    storeSlug: "cove",
    themes: ["pillow-shop"],
  },

  /* ---- Beta / coming-soon (no theme yet) ---- */
  {
    slug: "fragrance",
    label: "Perfumes & Fragrance",
    emoji: "🧴",
    keywords: ["perfume", "perfumes", "fragrance", "cologne", "scent", "attar", "eau de parfum"],
    margin: [40, 55], suppliers: [18, 40], monthlyRevenue: [4000, 14000],
    productIdeas: ["Signature Eau de Parfum", "Travel Spray Set", "Oud Collection", "Layering Kit"],
    countries: ["United States", "United Arab Emirates", "United Kingdom"],
    storeSlug: "bloom",
  },
  {
    slug: "health",
    label: "Health & Wellness",
    emoji: "➕",
    keywords: ["health", "wellness", "supplements", "vitamins", "nutrition", "fitness supplements"],
    margin: [45, 60], suppliers: [15, 35], monthlyRevenue: [4000, 14000],
    productIdeas: ["Daily Multivitamin", "Magnesium Glycinate", "Electrolyte Mix", "Wellness Bundle"],
    countries: ["United States", "Canada", "United Kingdom"],
    storeSlug: "cove",
  },
];

/** Generic fallback when a free-text idea matches nothing specific. */
export const genericNiche: Niche = {
  slug: "general",
  label: "Your Product Line",
  emoji: "🛍️",
  keywords: [],
  margin: [30, 50], suppliers: [15, 45], monthlyRevenue: [3000, 12000],
  productIdeas: ["Hero Product", "Everyday Bestseller", "Premium Bundle", "Gift Set"],
  countries: ["United States", "United Kingdom", "Canada"],
};

export type NicheMatchStrength = "strong" | "weak" | "none";

/** Filler words that don't count toward an idea's "meaningful" word total. */
const IDEA_STOP_WORDS = new Set([
  "i", "im", "id", "we", "my", "our", "a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with",
  "want", "wanna", "like", "would", "sell", "selling", "sale", "start", "starting", "launch", "build", "open",
  "online", "store", "shop", "brand", "business", "ecommerce", "website", "site", "some", "that", "this",
  "products", "product", "items", "stuff", "things",
]);

/** Lowercase, strip punctuation, collapse whitespace — applied to both the idea and each keyword. */
function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/**
 * Whole-word match, tolerating a plural suffix ("shoe" matches "shoes",
 * "watch" matches "watches") so keyword lists don't need every inflection.
 */
function wholeWordHit(idea: string, kw: string): boolean {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^| )${escaped}(?:e?s)?(?: |$)`).test(idea);
}

/**
 * Whole-word keyword hits are worth their full length; bare substring hits
 * ("fashion" inside "fashionable", "cream" inside "ice cream") are worth half
 * and only for keywords of 4+ chars, so "pet" never fires inside "carpet".
 * Substring-only matches can never be "strong" — that's the whole point of
 * this helper.
 */
const STRONG_MIN_COVERAGE = 0.25;
const STRONG_MIN_WORD_SCORE_AT_MIN_COVERAGE = 5;
const STRONG_HALF_COVERAGE = 0.5;
const STRONG_MIN_WORD_SCORE = 8;

/**
 * Niche match plus how much to trust it.
 *
 * Niches are ranked by whole-word score first, then total score — so a real
 * word hit ("dog" in "fashionable dog collars" -> Pets) always beats a
 * substring-only hit ("fashion" inside "fashionable" -> Fashion), which is
 * exactly the mis-match the old any-partial-hit-wins scoring produced.
 *
 *  - "strong": at least one whole-word keyword hit AND one of:
 *      (a) matched keywords cover >= 50% of the idea's meaningful words
 *          ("dog collars", "sneakers", "premium skincare");
 *      (b) they cover >= 25% AND the whole-word hits total >= 5 chars —
 *          a lone 3-4 letter word ("dog", "home", "tech") on 1-of-3 words
 *          is not enough on its own;
 *      (c) the whole-word hits total >= 8 chars — a distinctive niche word
 *          like "streetwear" or "skincare" is a strong signal even inside
 *          a long sentence.
 *  - "weak": some keyword overlap that doesn't meet the bar above — the
 *    reference niche is a loose fit and its numbers should be read as a
 *    ceiling, not a forecast.
 *  - "none": no overlap at all -> `genericNiche`.
 *
 * The thresholds are judgement calls tuned by hand against the keyword lists
 * above; they are deliberately conservative because "weak" only softens the
 * simulator's wording, while a false "strong" produces confident numbers for
 * the wrong business.
 */
export function matchNicheWithStrength(idea: string): { niche: Niche; strength: NicheMatchStrength } {
  const q = normalizeText(idea);
  const meaningfulWords = q.split(" ").filter((w) => w && !IDEA_STOP_WORDS.has(w));
  const wordTotal = Math.max(1, meaningfulWords.length);

  let best: Niche | null = null;
  let bestScore = 0;
  let bestWordScore = 0;
  let bestCoveredWords = 0;
  for (const n of niches) {
    let score = 0;
    let wordScore = 0;
    let coveredWords = 0;
    for (const raw of n.keywords) {
      const kw = normalizeText(raw);
      if (!kw) continue;
      if (wholeWordHit(q, kw)) {
        score += kw.length;
        wordScore += kw.length;
        coveredWords += kw.split(" ").length;
      } else if (kw.length >= 4 && q.includes(kw)) {
        score += kw.length / 2;
      }
    }
    const better = wordScore > bestWordScore || (wordScore === bestWordScore && score > bestScore);
    if (score > 0 && better) {
      bestScore = score;
      bestWordScore = wordScore;
      bestCoveredWords = coveredWords;
      best = n;
    }
  }
  if (!best || bestScore <= 0) return { niche: genericNiche, strength: "none" };

  const coverage = bestCoveredWords / wordTotal;
  const strong =
    bestWordScore > 0 &&
    (coverage >= STRONG_HALF_COVERAGE ||
      (coverage >= STRONG_MIN_COVERAGE && bestWordScore >= STRONG_MIN_WORD_SCORE_AT_MIN_COVERAGE) ||
      bestWordScore >= STRONG_MIN_WORD_SCORE);
  return { niche: best, strength: strong ? "strong" : "weak" };
}

/** Best-effort niche match from a free-text idea (keyword overlap). */
export function matchNiche(idea: string): Niche {
  return matchNicheWithStrength(idea).niche;
}

/** Niches with at least one live theme (the beta-available set). */
export function availableNiches(): Niche[] {
  return niches.filter((n) => n.themes && n.themes.length > 0);
}
