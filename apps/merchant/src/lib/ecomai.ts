import "server-only";

/**
 * EcomAI store-plan generator. AI gateway "workhorse" role, with a
 * deterministic preset fallback. Returns a plan plus the token count (for
 * metering).
 *
 * Goes through `@ecomstrait/ai` — this file never names a vendor or a model.
 * See `Docs/AI-Native-Migration-Plan.md`.
 */

import { chat, isGatewayConfigured } from "@ecomstrait/ai";

/** A media reference in a plan. `url` is absolute — CDN, bucket, or embed. */
export type PlanMedia = {
  url: string;
  kind: "image" | "video";
  alt?: string;
};

/**
 * An editable content block. Themes render what they support and skip the
 * rest, so adding a type here never breaks a store built on an older theme.
 */
export type PlanSection = {
  id: string;
  type: "text" | "image" | "video" | "gallery" | "features" | "products";
  heading?: string;
  body?: string;
  media?: PlanMedia[];
  items?: { title: string; description: string }[];
  /** `type: "products"` only — merchant-curated picks (e.g. "Best sellers"),
   *  in display order. Resolved to live product data at render/sync time. */
  productIds?: string[];
};

export type StorePlan = {
  storeName: string;
  tagline: string;
  brandColors: string[];
  heroHeadline: string;
  heroSub: string;
  about: string;
  collections: string[];
  seoTitle: string;
  seoDescription: string;
  source: "groq" | "preset";
  /** Everything below is optional: stores built before the content editor
   *  existed have none of it, and must keep rendering unchanged. */
  announcement?: string;
  /** One or more hero images/videos — more than one renders as a carousel. */
  heroMedia?: PlanMedia[] | null;
  aboutMedia?: PlanMedia | null;
  sections?: PlanSection[];
  footerText?: string;
};

/**
 * What `generateStorePlan` needs to build a plan around — the builder
 * conversation's own answers, kept as separate fields rather than one
 * flattened string. `presetPlan` needs that separation to stay sane: fed a
 * single pre-joined "Business: shoes. Customers: pakistan and my brand name
 * g4shoes. Preferred name: g4shoes" string (which is fine as context for the
 * *model* to parse — it's a poor sentence, not ambiguous — but is not
 * English on its own), a template built from `idea` verbatim put THAT whole
 * string in the tagline, hero headline and about text, verbatim, any time
 * the AI call fell back — including a partial fallback, where the model
 * came back fine but omitted just one of these keys. A real bug report: a
 * merchant's hero text read "Discover Business: Shoes. Customers: Pakistan
 * and my brand name g4shoes. Preferred name: g4shoes" word for word.
 */
export type PlanAnswers = {
  niche: string;
  audience?: string | null;
  styleKeyword?: string | null;
  storeName?: string | null;
};

/** A product as the plan/edit prompts want to see it — title plus the real
 *  category and price, so collections can be grouped and price-level copy
 *  can match the catalog (2026-09-07 capability audit, §3.2/§3.7). */
export type PromptProduct = { title: string; category?: string | null; price?: number | null };

/** "Blue Canvas Tote (Bags, $24)" — one line per product, omitting whatever's unknown. */
function describeProduct(p: PromptProduct): string {
  const meta = [p.category?.trim() || null, typeof p.price === "number" ? `$${p.price}` : null].filter(Boolean);
  return meta.length ? `${p.title} (${meta.join(", ")})` : p.title;
}

function presetPlan(answers: PlanAnswers): StorePlan {
  const niche = answers.niche.trim().replace(/\.$/, "") || "your products";
  const name =
    answers.storeName?.trim() ||
    niche.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ") ||
    "Your Store";
  return {
    storeName: name,
    tagline: `Premium ${niche.toLowerCase()}, delivered.`,
    brandColors: ["#0f172a", "#10b981", "#3b82f6"],
    heroHeadline: `Discover ${niche}`,
    heroSub: `Curated ${niche.toLowerCase()} for people who care about quality.`,
    about: `We started ${name} to make great ${niche.toLowerCase()} easy to find and love. Every product is chosen for quality, value, and the experience it brings.`,
    collections: ["Best Sellers", "New Arrivals", "Featured"],
    seoTitle: `${name} — Shop ${niche}`,
    seoDescription: `Shop curated ${niche.toLowerCase()} at ${name}. Quality products, fast shipping, and a store built by AI.`,
    source: "preset",
  };
}

// ---------------------------------------------------------------------------
// Builder conversation
// ---------------------------------------------------------------------------

export type BuilderTurn = { role: "user" | "assistant"; content: string };

/** What the merchant already decided before the conversation starts — see BuilderContext in store-builder.tsx. */
export type BuilderKnownContext = {
  productCount?: number;
  inferredNiche?: string;
  presetTheme?: string;
};

export type ConverseResult = {
  /** The assistant's next question, or its short wrap-up line once done. */
  reply: string;
  done: boolean;
  /** Null until known — same four slots the old fixed questions collected. */
  niche: string | null;
  audience: string | null;
  styleKeyword: string | null;
  storeName: string | null;
  tokensUsed: number;
  /**
   * They asked to actually SEE products (not just delegate what to sell) —
   * "show me some products", "what's selling well", "high margin options" —
   * at any point in this conversation, not just the opening question. The
   * caller (builder-actions.ts, which has DB access this file doesn't) is
   * responsible for fetching and rendering them; this only signals to do so.
   */
  showProducts?: boolean;
};

const BUILDER_SYSTEM = [
  "You are EcomAI, helping an entrepreneur set up an online store through a short, natural conversation.",
  "You need to learn: what they sell (niche), who their customers are AND which country/market they",
  "sell into (audience — one question covering both, e.g. \"Who are your customers, and which country",
  "are you selling to?\"), what visual style/vibe fits their brand, and what to name the store. The",
  "market matters: it decides currency, spelling, and the search terms the store's copy targets. If",
  "they answer only one half (just the people, or just the country), one short follow-up for the",
  "other half is fine — then move on, never ask a third time.",
  "Ask ONE short, conversational question at a time — never a list, never more than one question in a message.",
  "Don't drag this out: once you have enough to build a good store — often after 2-4 of their replies — stop asking.",
  "The store name is the one thing you must always actually ask about before finishing, even once",
  "niche/audience/style already feel like enough to build on — never silently invent or guess a name",
  "the merchant was never given a chance to weigh in on. Asking and them delegating it (\"you pick\",",
  "\"surprise me\") is fine and lets you finish; simply never having asked is not — check the",
  "conversation so far and if the name genuinely never came up, ask for it next before setting",
  "done=true, whatever else is already known.",
  "",
  "Classify every message as one of three types before anything else — this matters more than",
  "filling in the four answers, because guessing wrong here means ignoring what they actually said:",
  "",
  "Before that, one test applies no matter which type you land on: a reply only counts as usable —",
  "as a real answer OR as a real delegation of one — when it's actually clear enough to act on. A",
  "complete phrase says something definite: \"you decide\", \"you pick\", \"skip\", \"surprise me\",",
  "\"leather bags\", \"modern and clean\" all do, whichever of niche/audience/style/name they answer.",
  "A bare fragment that only resembles an answer — just \"you\" on its own, a shrug, \"whatever\", a",
  "flat \"idk\" with nothing else — is NOT the same thing, for ANY of the four fields, the store name",
  "included: it could be delegation, a typo, a cut-off thought, or something you haven't actually",
  "asked about. Never guess which one it is. Leave that field exactly as it was (null stays null, a",
  "known value stays known), classify the message as type \"other\" instead of \"answer\", and reply",
  "with your own short, warm clarifying question — written fresh, specific to whatever you'd",
  "actually just asked, never a fixed line reused turn after turn — then wait for them to actually",
  "say which they meant before treating it as an answer, a delegation, or a request to see options.",
  "",
  "\"answer\"         they answered (fully, partially, or by delegating — skip/you pick/surprise me)",
  "                 whatever you asked last. Fill in whichever of niche/audience/styleKeyword/",
  "                 storeName they gave or delegated; leave the rest as they were. Skip anything",
  "                 already given under \"Known so far\" below — never ask for it again.",
  "                 WHAT TO SELL is the one exception to delegating: if they delegate THAT (you",
  "                 tell, you decide, surprise me, I don't know) while niche is still unknown,",
  "                 don't invent one yourself and race to done=true — handle it exactly like type",
  "                 \"show_products\" below instead. A merchant who delegated what to sell needs to",
  "                 see real options, not discover what you picked after a store already got built.",
  "                 STORE NAME works the same way when they ask to SEE OPTIONS rather than blankly",
  "                 delegating — \"suggest a few names and I'll pick one\" is not the same as \"you",
  "                 pick\": propose 2-4 real candidate names right in reply (short, fitting the",
  "                 niche/style already known), leave storeName null, done=false, and wait for them",
  "                 to actually pick one — never silently choose for them when they asked to see",
  "                 choices.",
  "\"show_products\"  they want to actually SEE products, not answer a question — show me some, what's",
  "                 selling well, suggest some products, high margin options — or (see above)",
  "                 delegating what to sell before a niche is known. Can happen at ANY point in the",
  "                 conversation, whatever you were about to ask next, whatever's already known.",
  "                 \"suggest\"/\"recommend\" ONLY means this when what's being asked for is products or",
  "                 what to sell — asking you to suggest a STORE NAME, a tagline, a style, or anything",
  "                 else is type \"answer\" (they're delegating that specific question, per the rule",
  "                 above), never \"show_products\". If they already asked for a name and you're still",
  "                 deciding what to call it, \"suggest a few names\" means exactly that — names — not",
  "                 products, however similar the word \"suggest\" looks to the examples above.",
  "                 done=false always. reply is a short lead-in only (\"Here's what's doing well",
  "                 right now:\") — never list products yourself, they render separately elsewhere.",
  "                 Don't ask your pending question in this same reply; ask it on a later turn",
  "                 instead, once they've had a chance to look.",
  "\"other\"          neither of the above — a genuine question about the store or this process,",
  "                 confusion, something off-topic, anything that doesn't actually move the four",
  "                 answers forward. NEVER silently ignore this and just ask your next scripted",
  "                 question as if they'd answered it — that reads as not listening. Respond to",
  "                 what they actually said or asked, in reply, first. done=false. Only return to a",
  "                 pending question afterward, and only if it still makes sense to right then.",
  "",
  "Worked examples (message → type), mid-conversation, whatever you'd just asked:",
  "- \"handmade leather bags\" → answer (niche = \"handmade leather bags\")",
  "- \"young professionals in the UK\" → answer (audience = \"young professionals in the UK\" — who AND where)",
  "- \"modern, and call it Coastal Co\" → answer (styleKeyword = \"modern\", storeName = \"Coastal Co\" — two fields from one message is fine)",
  "- \"hmm what sells well for gifts?\" → show_products (they want to see options; niche stays as it was — \"gifts\" is not an answer yet)",
  "- \"you decide the name\" → answer (storeName delegated → stays null; done can now be true if niche is known)",
  "- \"suggest a few names\" → answer (propose 2-4 names in reply, storeName stays null, done=false — NOT show_products)",
  "- \"you\" → other (bare fragment — ask what they meant, change no field)",
  "- \"actually can I change the style later?\" → other (answer it — yes, everything is editable after the build — then return to your pending question)",
  "- \"what do you mean by style?\" → other (explain briefly with two or three example vibes, then wait)",
  "",
  "Warm, confident, concise. No hype, no emojis.",
  "Whatever the type, always fill in niche/audience/styleKeyword/storeName from the WHOLE",
  "conversation so far, not just this one message — a fact learned two turns ago is still known now.",
  "",
  "Respond with ONLY JSON, shaped exactly:",
  '{ "type": "answer" | "show_products" | "other", "done": boolean, "reply": string, "niche": string | null, "audience": string | null, "styleKeyword": string | null, "storeName": string | null }',
  "",
  '"niche" is a short phrase for what they sell (e.g. "handmade leather bags") — fill in your best guess as you learn more, null until you know anything.',
  '"audience" is a short phrase for who buys it AND where — carry the country/market in it whenever',
  '  they gave one (e.g. "young professionals in the UK", "parents in Pakistan", "UK buyers") — or null',
  "  if still open or they delegated it",
  "  (never store the delegation phrase itself, e.g. \"you decide\" is not a real audience — pick a",
  "  sensible default yourself when you build, same as an unanswered question, rather than writing",
  "  their words into the field).",
  '"styleKeyword" is a short word/phrase for the visual vibe (e.g. "luxury", "playful"), or null on',
  "  the same terms as audience above — delegated or unknown both mean null, never the literal phrase.",
  '"storeName" is what they want it called, once said — null if still open or they delegated it.',
  '"reply" is your next question for type "answer", your lead-in for "show_products", or your',
  '  response to whatever they said for "other".',
  'done=true only ever applies to type "answer", once you have enough — "reply" is then ONE',
  "  sentence that restates exactly what you're about to build, so a misheard detail gets caught",
  "  before a store exists: the niche, the audience/market, the style, and the name — or \"a name",
  '  I\'ll pick" when they delegated it. E.g. "Building a minimal-style store called Coastal Co',
  '  selling handmade leather bags to UK buyers." Never the bare "Got it — building your store."',
  '  "niche" must be filled in. Also never true unless the store name has actually come up in the',
  "  conversation (given, or asked and delegated) — see the store-name rule above.",
].join("\n");

/** The old fixed 4-question script, kept only as this conversation's no-gateway fallback. */
const PRESET_QUESTIONS = [
  { key: "niche", q: "What do you want to sell?" },
  { key: "audience", q: "Who are your customers, and which country are you targeting? (or say “skip”)" },
  { key: "style", q: "What style fits your brand — modern, luxury, playful, something else? (or “skip”)" },
  { key: "storeName", q: "What should we name the store? Say “you pick” and I'll choose." },
] as const;

// Broadened per the 2026-09-04 hallucination audit: the old pattern missed
// common "no opinion" phrasings ("not sure", "I don't know", "whatever",
// "doesn't matter") — in this fallback (no-gateway) path there's no LLM to
// catch those semantically, so a merchant using any of them got that exact
// literal text saved as a real field, including as the store's actual name.
function isSkippedAnswer(text: string): boolean {
  return /^(skip|none|no|na|-|you pick|you decide|whatever|not sure|no idea|i ?dk|i don'?t know|doesn'?t matter|any|surprise( me)?)$/i.test(
    text.trim(),
  );
}

/**
 * The one-sentence "here's what I'm about to build" recap the prompt asks for
 * on done=true — used only when the model returned no reply text of its own
 * (and by the no-gateway fallback), so the merchant never gets the bare
 * "Got it — building your store." with nothing to check against.
 */
function buildRecap(
  niche: string | null,
  audience: string | null,
  styleKeyword: string | null,
  storeName: string | null,
): string {
  const style = styleKeyword ? `${styleKeyword}-style ` : "";
  const name = storeName ? `called ${storeName}` : "with a name I'll pick";
  const who = audience ? ` for ${audience}` : "";
  return `Building a ${style}store ${name} selling ${niche ?? "your products"}${who}.`;
}

function presetConverse(history: BuilderTurn[], context: BuilderKnownContext): ConverseResult {
  const applicable = PRESET_QUESTIONS.filter(
    (q) => !(q.key === "niche" && context.inferredNiche) && !(q.key === "style" && context.presetTheme),
  );
  const answers = history.filter((h) => h.role === "user").map((h) => h.content.trim());

  if (answers.length < applicable.length) {
    return {
      done: false,
      reply: applicable[answers.length].q,
      niche: context.inferredNiche ?? null,
      audience: null,
      styleKeyword: context.presetTheme ?? null,
      storeName: null,
      tokensUsed: 0,
    };
  }

  const byKey = new Map(applicable.map((q, i) => [q.key, answers[i]]));
  const pick = (key: (typeof PRESET_QUESTIONS)[number]["key"]) => {
    const v = byKey.get(key);
    return v && !isSkippedAnswer(v) ? v.trim() : null;
  };

  const niche = context.inferredNiche ?? pick("niche");
  const audience = pick("audience");
  const styleKeyword = context.presetTheme ?? pick("style");
  const storeName = pick("storeName");
  return {
    done: true,
    reply: buildRecap(niche, audience, styleKeyword, storeName),
    niche,
    audience,
    styleKeyword,
    storeName,
    tokensUsed: 0,
  };
}

/**
 * A real conversation that decides its own questions — replaces the old
 * fixed 4-question script ("I don't want these 4 questions every time...
 * AI need to ask questions itself"). Stateless per call like every gateway
 * function here: the caller carries the running transcript and resends it
 * each turn (`chat()` has no server-side memory of its own).
 *
 * Deliberately doesn't generate the plan itself — that stays
 * `generateStorePlan`'s job (see `finalizeBuilderConversation` in
 * builder-actions.ts), so this function's only responsibility is figuring
 * out what to ask next and when enough is known.
 */
export async function converseBuilder(
  history: BuilderTurn[],
  context: BuilderKnownContext,
): Promise<ConverseResult> {
  if (!isGatewayConfigured()) return presetConverse(history, context);

  const known: string[] = [];
  if (context.productCount) known.push(`${context.productCount} product(s) already selected`);
  if (context.inferredNiche) known.push(`niche looks like "${context.inferredNiche}"`);
  if (context.presetTheme) known.push(`style/theme already chosen: ${context.presetTheme}`);
  const system = BUILDER_SYSTEM + (known.length ? `\n\nKnown so far: ${known.join("; ")}.` : "");

  // A real, confirmed live bug lived here: with 3+ messages of history (any
  // real back-and-forth, not just the opening question), the model currently
  // behind `workhorse` would deterministically (reproduced at temperature 0)
  // emit a single whitespace character and stop (`finish_reason: "stop"`, 1
  // completion token) instead of an actual JSON reply — `fast-cheap` and
  // `reasoning` handled the identical multi-turn+JSON-mode request correctly,
  // isolating it to whatever's mapped to this one role. Confirmed live that
  // `reasoningEffort: "none"` was making this WORSE, not better: with it set,
  // the same request instead burned its entire `maxTokens` budget on
  // invisible reasoning (`reasoning_tokens` pinned to the cap) and still
  // returned nothing. Dropping `reasoningEffort` entirely and giving the
  // model real room to actually think (see `converseBuilderOnce`'s
  // maxTokens/timeout below) resolved it reliably in live testing (0/3
  // failures after the fix, vs. a consistent failure before it on the exact
  // same multi-turn input). A retry stays here as defense in depth for a
  // genuine transient blip — degrading to `presetConverse()` below on total
  // failure is unchanged, so this only ever improves the odds of the real
  // conversation, never adds risk.
  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await converseBuilderOnce(system, history, context);
    } catch (err) {
      lastErr = err;
    }
  }
  console.error("[ai] converseBuilder failed after retries, falling back to the fixed script:", lastErr);
  return presetConverse(history, context);
}

async function converseBuilderOnce(
  system: string,
  history: BuilderTurn[],
  context: BuilderKnownContext,
): Promise<ConverseResult> {
  const { content, tokensUsed } = await chat(
    "workhorse",
    [{ role: "system", content: system }, ...history],
    // No `reasoningEffort` here, deliberately — every OTHER `workhorse`
    // call site in this file sets `reasoningEffort: "none"` because that
    // role is never supposed to need deep thought, but this specific call
    // (the only one sending real multi-turn history) measurably needed the
    // opposite: live testing showed `"none"` made this role's underlying
    // model burn its whole `maxTokens` budget on invisible reasoning and
    // return nothing for a 3+ message conversation, while leaving reasoning
    // unset and giving it real headroom (3000 tokens, a 20s timeout) let it
    // actually finish and answer correctly, consistently, on the identical
    // input. See the retry loop above for the full incident — don't
    // "simplify" this back to match the other call sites without retesting
    // a real multi-turn conversation first.
    { temperature: 0.7, maxTokens: 3000, responseFormatJson: true, timeoutMs: 20000 },
  );
  const parsed = JSON.parse(content) as {
    type?: string;
    done?: boolean;
    reply?: string;
    niche?: string | null;
    audience?: string | null;
    styleKeyword?: string | null;
    storeName?: string | null;
  };

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const niche = str(parsed.niche) ?? context.inferredNiche ?? null;
  const styleKeyword = str(parsed.styleKeyword) ?? context.presetTheme ?? null;
  const reply =
    str(parsed.reply) ??
    (parsed.done
      ? buildRecap(niche, str(parsed.audience), styleKeyword, str(parsed.storeName))
      : "Tell me a bit more.");
  // Asking to see products is never "done" — showing options isn't the
  // same as having enough to build, whatever the model said alongside it.
  // "other" (a real question, confusion, off-topic) isn't "done" either —
  // only "answer" can complete the build.
  const showProducts = parsed.type === "show_products";
  // Allowlist, not exclusion — a case/spelling drift in the model's own
  // output (e.g. "Answer", "completed") must never be silently treated as a
  // valid completed answer just because it doesn't match the other two
  // known values; it now safely falls through to "ask again" instead.
  const isAnswer = parsed.type === "answer";

  // "done" with no niche isn't usable — generateStorePlan needs something to
  // build around, so treat it as one more turn rather than handing it "".
  if (!(isAnswer && parsed.done && niche) || showProducts) {
    return {
      done: false,
      reply,
      niche,
      audience: str(parsed.audience),
      styleKeyword,
      storeName: str(parsed.storeName),
      tokensUsed,
      showProducts,
    };
  }

  return { done: true, reply, niche, audience: str(parsed.audience), styleKeyword, storeName: str(parsed.storeName), tokensUsed };
}

/** Map a free-text style answer to one of our themes. */
export function themeForStyle(style?: string): string {
  const s = (style ?? "").toLowerCase();
  if (/lux|premium|high.?end|gold|elegant/.test(s)) return "noir";
  if (/play|fun|bright|color|bold.?fun|vibrant/.test(s)) return "bloom";
  if (/calm|editorial|magazine|soft|story/.test(s)) return "cove";
  if (/bold|industrial|street|gear|rugged/.test(s)) return "forge";
  if (/marble|refined|timeless|neutral/.test(s)) return "marble";
  return "aurora"; // modern / minimal default
}

/** Apply a cosmetic change (colors/text) to an existing plan. */
/**
 * The plan fields EcomAI is allowed to write.
 *
 * Everything else on a plan is either derived (`source`) or owned by the
 * merchant through the media library — the model has no way to know an
 * uploaded asset's URL, so anything it invented for `heroMedia` or a section
 * would 404 on a live store.
 */
const EDITABLE = [
  "storeName", "tagline", "brandColors", "heroHeadline", "heroSub", "about",
  "collections", "seoTitle", "seoDescription", "announcement", "footerText",
] as const;

type EditableField = (typeof EDITABLE)[number];

/**
 * A whole standalone page (Contact Us, FAQ, Shipping, ...) to create, edit,
 * or remove — distinct from `changes`, which only ever touches the fixed
 * StorePlan fields above. Persisting this is the caller's job (it's a
 * `store_pages` row, not part of the plan) — see `applyPageAction` in
 * builder-actions.ts.
 */
export type PageAction = {
  action: "create" | "update" | "delete";
  /** Lowercase-hyphenated, e.g. "contact-us" — the URL segment. */
  slug: string;
  title?: string;
  /** Plain text, paragraphs separated by a blank line. Omitted for a delete. */
  body?: string;
};

/** See `applyMerchantRequest`'s `storeContext` parameter. */
export type StoreContext = {
  products?: PromptProduct[];
  existingPosts?: { title: string; slug: string }[];
  country?: string | null;
};

export type MerchantReply = {
  plan: StorePlan;
  /** What EcomAI says back. Never empty. */
  reply: string;
  /** Fields actually changed, for the caller to summarise or log. */
  changed: EditableField[];
  tokensUsed: number;
  /** Set only when the merchant asked for a whole page, not a field edit. */
  pageAction?: PageAction;
  /**
   * Set only when the merchant asked what to sell — a category/niche hint
   * for the caller's `suggestProductsForStore()` (this function has no DB
   * access, so it can't rank products itself; see `builder-actions.ts`).
   * `null`/omitted means use the store's own niche.
   */
  productCategory?: string | null;
  /**
   * The model's own classification of the request — NOT the same thing as
   * `changed.length === 0`. An "edit"/"page" request that needed
   * clarification (or a "unsupported" one, which already has a correct,
   * specific reply) also leaves `changed` empty, but neither is a genuine
   * question. Callers must only escalate to a business-question fallback
   * (e.g. the LangGraph advisor) when this is exactly `"question"` — that
   * advisor has no idea this chat can edit store content at all, and will
   * happily invent wrong instructions (like "go into Shopify Admin") for a
   * request this function already understands perfectly well.
   */
  intent: "edit" | "page" | "suggest_products" | "question" | "unsupported";
};

/** Human labels, so a fallback summary reads like a sentence. */
const FIELD_LABEL: Record<EditableField, string> = {
  storeName: "store name", tagline: "tagline", brandColors: "brand colours",
  heroHeadline: "hero headline", heroSub: "hero subheading", about: "about text",
  collections: "collections", seoTitle: "SEO title", seoDescription: "SEO description",
  announcement: "announcement bar", footerText: "footer note",
};

function isHexList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0
    && v.every((c) => typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c.trim()));
}

/**
 * Copy the model's proposed changes onto the plan, field by field.
 *
 * A patch rather than a whole-plan replacement, because a replacement is what
 * silently dropped merchants' media and content sections: any key the model
 * omitted vanished. Here an omitted key simply isn't touched, and a value of
 * the wrong shape is discarded rather than written.
 */
function applyChanges(
  plan: StorePlan,
  changes: Record<string, unknown>,
): { plan: StorePlan; changed: EditableField[] } {
  const next: StorePlan = { ...plan };
  const changed: EditableField[] = [];

  for (const field of EDITABLE) {
    if (!(field in changes)) continue;
    const value = changes[field];

    if (field === "brandColors") {
      if (!isHexList(value)) continue;
      const colors = value.map((c) => c.trim()).slice(0, 3);
      if (JSON.stringify(colors) === JSON.stringify(plan.brandColors)) continue;
      next.brandColors = colors;
      changed.push(field);
      continue;
    }

    if (field === "collections") {
      if (!Array.isArray(value) || !value.every((c) => typeof c === "string")) continue;
      const list = (value as string[]).map((c) => c.trim()).filter(Boolean).slice(0, 5);
      if (!list.length || JSON.stringify(list) === JSON.stringify(plan.collections)) continue;
      next.collections = list;
      changed.push(field);
      continue;
    }

    if (typeof value !== "string") continue;
    const text = value.trim();
    // The announcement bar and footer note are the only fields a merchant can
    // legitimately clear by asking, so an empty string means something there.
    const clearable = field === "announcement" || field === "footerText";
    if (!text && !clearable) continue;
    if (text === (plan[field] ?? "")) continue;
    next[field] = text;
    changed.push(field);
  }

  return { plan: next, changed };
}

/** "the tagline and the brand colours" */
function listFields(fields: EditableField[]): string {
  const names = fields.map((f) => FIELD_LABEL[f]);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const MERCHANT_SYSTEM = [
  "You are EcomAI, an ecommerce co-founder helping a merchant with their store.",
  "",
  "Reply with JSON only, shaped exactly:",
  '{ "intent": "edit" | "page" | "suggest_products" | "question" | "unsupported", "reply": "...", "changes": { }, "page": null | { "action": "create" | "update" | "delete", "slug": "...", "title": "...", "body": "..." }, "productCategory": null | "..." }',
  "",
  '"edit"        they asked you to change an existing field. Put ONLY the fields',
  "              you are changing in changes — omit every field you are leaving",
  '              alone. "page" must be null. Bias toward "edit" for ANYTHING',
  "              about the store's own presentation — the hero text/headline,",
  "              subheading, tagline, colours, about text, SEO, announcement,",
  "              or footer — even if the message is garbled, has typos, or",
  "              doesn't say what the new text should be yet. In that last",
  '              case leave changes empty and use reply to ask exactly what',
  "              they want it to say — that is still intent \"edit\", not",
  '              "question": you already know how to make this change, you',
  "              just need one more detail before you can. The same applies to",
  "              \"change it back\" / \"undo that\": you have no record of the",
  "              previous value, so ask which field and what it should say.",
  "                SEO requests (\"improve my SEO\", \"is my SEO good\", \"what",
  "                keywords should I target\", \"audit my SEO\") are also \"edit\",",
  "                and follow this method every time:",
  "                1. Derive ONE primary keyword and 2-3 secondary keywords from",
  "                   what the store actually sells and where: the products and",
  "                   market listed below when given, else the plan's own",
  "                   collections/about/tagline. A keyword is the phrase a",
  "                   buyer would type (\"handmade leather bags UK\"), not a",
  "                   brand adjective. If neither source says what the store",
  "                   sells or where, ask for the product focus and market",
  "                   first — never invent keywords.",
  "                2. Check where the primary keyword is missing: seoTitle, the",
  "                   FIRST sentence of seoDescription, and about. Those are",
  "                   the gaps — name them specifically in reply, never a",
  "                   vague \"looks fine\".",
  "                3. Rewrite only what's actually weak: seoTitle as",
  "                   \"Primary Keyword – Store Name\" <= 60 chars; seoDescription",
  "                   120-155 chars with the keyword in its first half, one",
  "                   USP, and a call to action; about's first sentence naming",
  "                   the niche and market. Work secondary keywords into",
  "                   about/heroSub naturally — never stuffed, never a list.",
  "                4. Never change storeName in an SEO pass unless they",
  "                   explicitly asked to rename the store.",
  "                5. In reply, name the keyword you targeted and the specific",
  "                   gap you fixed (\"Targeted 'handmade leather bags UK' — the",
  "                   title had no product word and the description had no call",
  "                   to action\").",
  "                Scope: on this platform about text, page bodies and blog",
  "                bodies are plain text — there are no headings, schema",
  "                markup, image alt text, or internal links to edit here.",
  "                Never recommend those as things to do; if asked, say the",
  "                platform doesn't support them yet.",
  '"page"        they want to add, change, or remove a WHOLE PAGE — "add a',
  '              Contact Us page", "make a FAQ page", "remove the Shipping',
  '              page", "update the About page to mention our new hours".',
  "              This is a real, supported capability — never call it",
  '              unsupported. Fill "page"; changes must be empty.',
  "              A BLOG POST IS NOT A PAGE, even though \"add a...\" sounds the",
  "              same — a page here means a static page like Contact Us or FAQ.",
  "              \"write/add a blog post\" is unsupported (see below): this chat",
  "              has no blog-writing ability of its own, that's a separate",
  "              screen with its own AI writer.",
  '                action  "create" (or reuse for an existing slug — same as',
  "                        update), \"update\", or \"delete\".",
  '                slug    lowercase-hyphenated url segment, e.g. "contact-us".',
  '                        Reuse the existing slug when editing/removing a page',
  "                        already mentioned above.",
  "                        DELETE ONLY ON AN EXACT MATCH: if what they said",
  "                        doesn't unambiguously match exactly one existing",
  "                        page by slug or title (none match, or two could),",
  "                        set page to null and ask which one in reply, naming",
  "                        the candidates — never delete on a guess; a deleted",
  "                        page can't be restored.",
  "                title   the page's heading. Omit for a delete.",
  "                body    the page's content: plain text, a blank line between",
  "                        paragraphs, no markdown. Write real content using",
  "                        facts already given in this conversation or already",
  "                        visible in the store's own fields below (contact",
  "                        details, address, policies, hours). Never invent a",
  "                        phone number, address, policy, or claim you don't",
  "                        actually have — if the merchant hasn't told you what",
  "                        a page should say, ask them instead of making it up.",
  "                        Omit for a delete.",
  '"suggest_products" they want help deciding WHAT TO SELL — "what should I',
  '              sell", "suggest some products", "what\'s selling well",',
  '              "help me pick products for this store". This is a real,',
  "              supported capability — never call it unsupported. changes",
  '              and page must be empty/null. Set "productCategory" to a',
  "              short category/niche hint if the conversation makes one",
  "              clear (e.g. the store's own collections, or something they",
  '              just said), otherwise null to use the store\'s own niche.',
  "              reply is a short, one-line lead-in (\"Here's what's doing",
  "              well right now:\") — the actual picks are rendered",
  "              separately, don't list products yourself in reply.",
  '"question"    a genuine question that ISN\'T about editing this store\'s own',
  "              content — a how-to question, or something that needs looking",
  "              up (an order, a number, a policy). Answer it in reply. changes",
  '              and page must be empty/null. Never use "question" for a',
  "              request to change the store's own presentation — see \"edit\"",
  "              and \"page\" above, which cover that even when incomplete.",
  "              For how-does-the-dashboard-work questions, answer ONLY from",
  "              the section manifest below: say in one line what the section",
  "              is for and tell them to open it. Never describe buttons,",
  "              steps, or capabilities that aren't written there — if the",
  "              manifest doesn't answer it, say you're not sure and point",
  "              them at the closest section.",
  '"unsupported" they want something genuinely outside this chat — adding a',
  "              SPECIFIC product they already have in mind (not asking for",
  '              suggestions — see "suggest_products" above), writing/adding a',
  "              blog post (see the note under \"page\" above), uploading",
  "              images, prices, shipping rates, payments, domains — anything",
  "              that isn't a store-plan field or a page. Say so plainly and",
  "              point them at the real dashboard section that handles it,",
  "              from the manifest below — never invent a section name or a",
  "              capability that isn't listed there.",
  "",
  "Worked examples (message → intent):",
  '- "add a returns section to the about text" → edit (changes.about, appended)',
  '- "add a returns page" → page (create, slug "returns"; ask what the policy says if you weren\'t told)',
  '- "what should our returns policy say" → question (advise in reply; change nothing)',
  '- "add a post about returns" → unsupported (blog posts live on the store\'s Blog screen)',
  '- "change it back" → edit, changes empty, reply asks which field and to what — there is no record of the previous value',
  '- "make the headline punchier" → edit (rewrite heroHeadline; you have enough to act)',
  '- "how\'s my SEO" → edit (run the SEO method above)',
  '- "what sells well in this niche" → suggest_products',
  '- "delete the shipping page" when the pages are "shipping-info" and "shipping-returns" → page with page null, reply asks which of the two',
  '- "how do I connect my own domain" → question (Settings, per store — say that and tell them to open it)',
  '- "upload a new hero image" → unsupported (the Content editor under Stores → this store → Edit with EcomAI)',
  '- "add my blue canvas tote to the store" → unsupported (Find Products adds specific products)',
  "",
  "Dashboard sections — the ONLY ones that exist, and what each actually does:",
  '  "Overview"            read-only: plan, AI tokens used today, store count.',
  '  "Find Products"       search and filter supplier products (by supplier or category), see',
  "                        cost/sell price/margin/stock, and add a product to a store (or to the",
  "                        pre-launch selection). Product data itself can't be edited there.",
  '  "Selected Inventory"  products already chosen or listed: edit the sell price (within the',
  "                        supplier's floor), add a shipping/returns note, remove a listing, see",
  "                        the supplier's approval status. It cannot edit product titles, images,",
  "                        cost or supplier.",
  '  "Store Builder"       chat-driven build of a NEW store, with preview and launch.',
  '  "Stores"              every store, with per-store actions: preview, resume or discard a',
  "                        draft, Edit with EcomAI (this chat plus the Content editor for the",
  "                        announcement, hero, about, sections and media, with version history),",
  "                        Shopify provisioning/sync, launch checklist, archive/delete, and the",
  "                        Blog link.",
  '  "Blog"                Stores → this store → Blog: create a post from a title or AI-draft one',
  "                        from a topic; edit title, slug, excerpt, cover image, body, SEO title",
  "                        and description; publish/unpublish; delete.",
  '  "Orders"              read-only list of orders: customer, items, total, payment and',
  "                        fulfilment status. No fulfil/refund/cancel actions there.",
  '  "Sales"               read-only analytics: net revenue, gross sales, orders, average order,',
  "                        units, pending payout, a 14-day chart, top products.",
  '  "Wallet"              add credits, withdraw funds, transaction history, held orders.',
  '  "Billing"             plan tiers and daily AI token limits; upgrade or manage billing.',
  '  "Settings"            profile name/avatar, email, password — and per store: rename it and',
  "                        connect a custom domain (DNS records, verify).",
  '  "Co-Founder"          a chat about the whole business (revenue, orders, wallet) — advice.',
  '  There is no "Products" section, no "Navigation" section, and no manual pages editor —',
  "  custom pages exist only through this chat.",
  "",
  "Fields allowed in changes:",
  "  storeName, tagline, heroHeadline, heroSub, about, seoTitle, seoDescription,",
  "  announcement, footerText  - strings",
  '  brandColors               - array of 1-3 hex colours like "#0f172a"',
  "  collections               - array of up to 5 short category names",
  "",
  "You cannot change images, video or content sections through changes; the",
  "merchant manages those under Content. If asked for those specifically",
  "(not a whole page), say so rather than inventing a URL.",
  "",
  "reply is spoken to the merchant: one or two sentences, first person, and",
  'specific about what you actually changed. Never reply with just "updated".',
  "Plain text only — no markdown (no **bold**, no bullet lists, no headings).",
].join("\n");

/**
 * Handle a merchant's message: apply what they asked for, and say what happened.
 *
 * Replaces a version that always returned a whole plan and left the caller to
 * print a fixed "Updated — check the preview." It could not answer a question,
 * could not tell the merchant what it had done, and silently no-opped on
 * anything outside nine cosmetic fields.
 */
export async function applyMerchantRequest(
  plan: StorePlan,
  instruction: string,
  /** Slug/title of every page the store already has, so the model can match
   *  an update/delete to the right one instead of guessing a new slug. */
  existingPages: { slug: string; title: string }[] = [],
  /** The persisted chat thread's rolling summary, when there is one — this
   *  call has no message history of its own (each instruction is evaluated
   *  independently against the current plan), so this is the one thread of
   *  memory it gets of anything said earlier in the conversation. See
   *  `Docs/prompts/merchant-chat-edit-and-pages.md`. */
  conversationSummary?: string | null,
  /** Real facts about the store beyond its plan fields — what it actually
   *  sells, what's already been posted, where it sells — so an SEO pass can
   *  derive keywords from the catalog instead of guessing, and a "what
   *  should I write about" question can see what's already there. All
   *  optional; callers that don't have them keep working unchanged
   *  (2026-09-07 capability audit, §1.1/§1.6/§4.7). */
  storeContext?: StoreContext,
): Promise<MerchantReply> {
  const text = instruction.trim();
  if (text.length < 2) {
    // "unsupported", not "question" — there's nothing here for a business
    // advisor to answer either, and this intent value is what stops the
    // caller from escalating a near-empty message to one.
    return { plan, reply: "Tell me what you'd like to change.", changed: [], tokensUsed: 0, intent: "unsupported" };
  }
  if (!isGatewayConfigured()) {
    return {
      plan,
      reply:
        "I can't reach the AI service right now, so nothing has changed. You can still edit everything by hand under Content.",
      changed: [],
      tokensUsed: 200,
      intent: "unsupported",
    };
  }

  // The model can't act on media or sections, so sending them spends context
  // the instruction and the plan's text fields need.
  const visible: Record<string, unknown> = {};
  for (const f of EDITABLE) if (plan[f] !== undefined) visible[f] = plan[f];

  const contextLines: string[] = [];
  if (storeContext?.products?.length) {
    contextLines.push(
      `Products on this store (real, title (category, $price) where known): ${storeContext.products
        .slice(0, 30)
        .map(describeProduct)
        .join("; ")}`,
    );
  }
  if (storeContext?.existingPosts?.length) {
    contextLines.push(
      `Existing blog posts: ${storeContext.existingPosts
        .slice(0, 20)
        .map((p) => `${JSON.stringify(p.title)} (/blog/${p.slug})`)
        .join(", ")}`,
    );
  }
  if (storeContext?.country?.trim()) contextLines.push(`Market: ${storeContext.country.trim()}`);

  try {
    const { content, tokensUsed } = await chat(
      "workhorse",
      [
        { role: "system", content: MERCHANT_SYSTEM },
        {
          role: "user",
          content: `Current store (real, verified):\n${JSON.stringify(visible)}\n\nExisting pages: ${
            existingPages.length ? JSON.stringify(existingPages) : "(none yet)"
          }${contextLines.length ? `\n\n${contextLines.join("\n")}` : ""}${
            conversationSummary
              ? `\n\nYour own recollection of earlier in this conversation (a summary you wrote — may be imprecise, unlike the store data above; if it conflicts with what they're saying now, what they're saying now wins): ${conversationSummary}`
              : ""
          }\n\nMerchant says: ${text}`,
        },
      ],
      // reasoningEffort: "none" — see the note on the converseBuilder call
      // above. Real bug this fixed: "do it yourself, what's the best" (an
      // open-ended edit request) made the reasoning-capable model behind
      // this role spend its whole 900-token budget "thinking" and return
      // empty content — surfaced to the merchant as "the AI service didn't
      // answer in time," even though the actual issue was never a timeout.
      { temperature: 0.4, maxTokens: 900, responseFormatJson: true, timeoutMs: 15000, reasoningEffort: "none" },
    );

    const parsed = JSON.parse(content) as {
      intent?: string;
      reply?: string;
      changes?: Record<string, unknown>;
      page?: { action?: string; slug?: string; title?: string; body?: string } | null;
      productCategory?: string | null;
    };

    const modelReply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";

    // Allowlist, not "anything unrecognized becomes edit" — that coercion
    // used to be able to turn a genuine question into a confusing "couldn't
    // tell what to change" non-answer if the model's own output ever drifted
    // outside the five literal values (a real gap found in the 2026-09-04
    // hallucination audit). An unrecognized value is now its own explicit,
    // visible failure instead of a silently wrong guess.
    const VALID_INTENTS = ["edit", "page", "suggest_products", "question", "unsupported"] as const;
    if (!VALID_INTENTS.includes(parsed.intent as (typeof VALID_INTENTS)[number])) {
      console.error("[ai] applyMerchantRequest: unrecognized intent from model:", JSON.stringify(parsed.intent));
      return {
        plan,
        reply: modelReply || "I didn't quite catch what you'd like me to do — could you rephrase that?",
        changed: [],
        tokensUsed,
        intent: "unsupported",
      };
    }
    const intent = parsed.intent as (typeof VALID_INTENTS)[number];

    if (intent === "suggest_products") {
      return {
        plan,
        reply: modelReply || "Here's what's doing well right now:",
        changed: [],
        tokensUsed,
        intent: "suggest_products",
        productCategory: typeof parsed.productCategory === "string" ? parsed.productCategory.trim() : null,
      };
    }

    if (intent === "page") {
      const slug = typeof parsed.page?.slug === "string" ? parsed.page.slug.trim() : "";
      const rawAction = parsed.page?.action;
      // A real bug this fixed: any unrecognized action string (a plausible
      // model drift like "remove" instead of "delete") used to silently fall
      // through to "create" — which, for an existing slug, actually means
      // *update* (see the doc comment above: "create (or reuse for an
      // existing slug — same as update)"), and the model believing it was
      // deleting would omit title/body, so the real page got its content
      // silently wiped instead of removed, while still reporting success.
      // Missing entirely (undefined) still means "create", same as before —
      // only a present-but-wrong value is now its own explicit failure.
      if (rawAction !== undefined && rawAction !== "create" && rawAction !== "update" && rawAction !== "delete") {
        console.error("[ai] applyMerchantRequest: unrecognized page action from model:", JSON.stringify(rawAction));
        return {
          plan,
          reply: "I couldn't tell if you meant to add, edit, or remove that page — which did you mean?",
          changed: [],
          tokensUsed,
          intent: "page",
        };
      }
      const action = rawAction === "delete" ? "delete" : rawAction === "update" ? "update" : "create";
      // A delete is the one page action that can't be undone, so it only
      // ever goes through on an exact slug match against the pages the
      // caller said exist — the prompt asks the model to clarify instead of
      // guessing, and this makes sure a guess can't slip past it (2026-09-07
      // capability audit, T10/§4.2).
      if (action === "delete" && slug && !existingPages.some((p) => p.slug === slug)) {
        const names = existingPages.map((p) => `"${p.title}"`).join(", ");
        return {
          plan,
          reply: existingPages.length
            ? `I couldn't find a page matching "${slug}" — which one did you mean: ${names}?`
            : "This store doesn't have any custom pages yet, so there's nothing to remove.",
          changed: [],
          tokensUsed,
          intent: "page",
        };
      }
      // No slug means the model couldn't actually carry this out — treat it
      // like it had nothing to change, rather than reporting success.
      if (!slug) {
        return {
          plan,
          reply: modelReply || "Which page, and what should it say?",
          changed: [],
          tokensUsed,
          intent: "page",
        };
      }
      return {
        plan,
        reply: modelReply || "On it.",
        changed: [],
        tokensUsed,
        intent: "page",
        pageAction: {
          action,
          slug,
          title: typeof parsed.page?.title === "string" ? parsed.page.title.trim() : undefined,
          body: typeof parsed.page?.body === "string" ? parsed.page.body.trim() : undefined,
        },
      };
    }

    // A question must never mutate the store, whatever the model returned
    // alongside its answer.
    if (intent !== "edit") {
      return {
        plan,
        reply: modelReply || "I'm not sure how to help with that one — could you rephrase it?",
        changed: [],
        tokensUsed,
        intent,
      };
    }

    const { plan: updated, changed } = applyChanges(plan, parsed.changes ?? {});

    // Trust the diff over the model's account of itself. Claiming success when
    // nothing valid came back is a lie the merchant finds in the preview.
    // Still intent "edit" — the model recognised this as a content change, it
    // just needs one more detail (e.g. what the new hero text should say).
    // This must never be treated as a "question" and escalated elsewhere.
    if (!changed.length) {
      const vague = !modelReply || /^(updated|done|ok)\b/i.test(modelReply);
      return {
        plan,
        reply: vague
          ? 'I couldn\'t tell what to change from that — try naming the part of the store, like "make the headline shorter" or "use a deep green".'
          : modelReply,
        changed: [],
        tokensUsed,
        intent: "edit",
      };
    }

    return {
      plan: { ...updated, source: "groq" },
      reply: modelReply || `Updated the ${listFields(changed)}.`,
      changed,
      tokensUsed,
      intent: "edit",
    };
  } catch {
    return {
      plan,
      reply:
        "That didn't go through — the AI service didn't answer in time. Nothing was changed, so try again in a moment.",
      changed: [],
      intent: "unsupported",
      tokensUsed: 200,
    };
  }
}

const PLAN_SYSTEM = [
  "You are EcomAI, building an online store for an entrepreneur.",
  "Given a business idea and their selected products, return a concise, on-brand",
  "store plan. Warm, confident, no hype, no emojis in text fields.",
  "",
  "Before writing any copy, decide the brand brief in two lines for yourself: who exactly this store",
  "is for, and why they'd buy here rather than anywhere else (one positioning, one USP, a tone that",
  "fits the style given and the price level of the listed products). Output that brief nowhere —",
  "write every field below from it, so tagline, hero, about and SEO all say the same thing to the",
  "same customer instead of interchangeable store copy.",
  "",
  "Rules:",
  "- storeName: if a Preferred name is given, storeName MUST be exactly that name, character for",
  "  character — never improve, shorten, restyle or replace it. Only invent a name when none is given.",
  "- collections: 3-5 names, and every one MUST group at least one of the listed products by its real",
  "  category (the category shown in parentheses after each title). Never invent a collection that",
  "  nothing listed fits — an empty collection on the storefront is worse than a missing one; fewer",
  "  real collections beat more invented ones. With no products listed, use the niche's obvious",
  "  sub-types.",
  "- brandColors: exactly 3 hex colors in this order: [primary, accent, background]. Primary and",
  "  accent sit behind white button text, so each must be dark or saturated enough for WCAG AA",
  "  contrast (4.5:1) against #ffffff — no pastels, yellows, or light greys there. Background is a",
  "  light neutral both read well on.",
  "- Lengths: heroHeadline <= 60 characters, tagline <= 70, heroSub <= 140 — they wrap on phones.",
  "- SEO: derive ONE primary keyword from the niche plus the market — the phrase a buyer would",
  '  actually type, e.g. "handmade leather bags UK". seoTitle = "Primary Keyword – Store Name",',
  "  <= 60 characters total (trim the keyword, never the name). seoDescription is 120-155 characters",
  "  with the primary keyword in its first half, one USP from the brief, and a call to action.",
  "  about is 2-3 sentences whose FIRST sentence names the niche and the market in plain words.",
  "- Copy must match the products: price-level words (affordable, premium, luxury) must fit the",
  "  listed prices — never call $9 products luxury or $400 ones budget.",
  "- Never invent facts about the store or its products (materials, origins, guarantees, years in",
  "  business) — write with authority about the category, not with claims you weren't given.",
  "",
  "Respond with ONLY JSON using these exact keys:",
  "{",
  '  "storeName": string,          // exactly the Preferred name when one is given',
  '  "tagline": string,            // <= 70 chars',
  '  "brandColors": string[],      // exactly 3 hex colors: [primary, accent, background]',
  '  "heroHeadline": string,       // <= 60 chars',
  '  "heroSub": string,            // <= 140 chars',
  '  "about": string,              // 2-3 sentences; the first names the niche and the market',
  '  "collections": string[],      // 3-5 names, each grouping at least one listed product',
  '  "seoTitle": string,           // "Primary Keyword – Store Name", <= 60 chars',
  '  "seoDescription": string      // 120-155 chars: keyword in the first half + USP + call to action',
  "}",
].join("\n");

/** "Business: shoes. Customers/market: Pakistan. Style: minimal. Preferred name: G4Shoes" — the model's own context, not shown to the merchant. */
function describeIdea(answers: PlanAnswers): string {
  return [
    `Business: ${answers.niche}`,
    answers.audience ? `Customers/market: ${answers.audience}` : "",
    answers.styleKeyword ? `Style: ${answers.styleKeyword}` : "",
    answers.storeName ? `Preferred name: ${answers.storeName}` : "",
  ]
    .filter(Boolean)
    .join(". ");
}

const PLAN_ATTEMPTS = 2;

export async function generateStorePlan(
  answers: PlanAnswers,
  productTitles: string[],
  /** Optional richer view of the same products — when given, the model is
   *  sent "title (category, $price)" lines instead of bare titles, and
   *  `productTitles` is ignored. Callers that only have titles keep working. */
  products?: PromptProduct[],
): Promise<{ plan: StorePlan; tokensUsed: number }> {
  if (!isGatewayConfigured() || answers.niche.trim().length < 2) {
    return { plan: presetPlan(answers), tokensUsed: 400 };
  }

  const productLines = products?.length
    ? products.slice(0, 20).map(describeProduct)
    : productTitles.slice(0, 20);
  const user = `Business idea: ${describeIdea(answers)}\nSelected products (title (category, $price) where known): ${
    productLines.join("; ") || "(none yet)"
  }`;

  // A merchant's whole storefront is riding on this one call — worth one
  // retry on a transient failure before falling all the way back to the
  // generic preset, same principle as `askCoFounder`'s retry.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
    try {
      const { content, tokensUsed } = await chat(
        "workhorse",
        [
          { role: "system", content: PLAN_SYSTEM },
          { role: "user", content: user },
        ],
        // reasoningEffort: "none" — see the note in converseBuilder above.
        { temperature: 0.7, maxTokens: 900, responseFormatJson: true, timeoutMs: 12000, reasoningEffort: "none" },
      );
      const p = JSON.parse(content) as Partial<StorePlan>;
      const base = presetPlan(answers);
      // The prompt mandates the preferred name, but a merchant's chosen name
      // is not something to leave to an instruction — pin it here so every
      // caller (builder and Co-Founder alike) gets it without patching it
      // back themselves (2026-09-07 capability audit, §3.1/§9.5).
      const preferredName = answers.storeName?.trim();
      return {
        plan: {
          storeName: preferredName || p.storeName || base.storeName,
          tagline: p.tagline || base.tagline,
          brandColors: Array.isArray(p.brandColors) && p.brandColors.length ? p.brandColors.slice(0, 3) : base.brandColors,
          heroHeadline: p.heroHeadline || base.heroHeadline,
          heroSub: p.heroSub || base.heroSub,
          about: p.about || base.about,
          collections: Array.isArray(p.collections) && p.collections.length ? p.collections.slice(0, 5) : base.collections,
          seoTitle: p.seoTitle || base.seoTitle,
          seoDescription: p.seoDescription || base.seoDescription,
          source: "groq",
        },
        tokensUsed,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  console.error("[ai] generateStorePlan failed after retry:", lastErr);
  return { plan: presetPlan(answers), tokensUsed: 400 };
}

// ---------------------------------------------------------------------------
// Blog drafts
// ---------------------------------------------------------------------------

export type BlogDraft = {
  title: string;
  /** One sentence — shown in the blog list, not the full post. */
  excerpt: string;
  /** Plain text, paragraphs separated by a blank line, plus two structural
   *  line forms the storefront renderer understands: a line starting with
   *  "## " is a subheading, consecutive lines starting with "- " are a bullet
   *  list (see `blog-post-view.tsx`). No other markup. */
  body: string;
  seoTitle: string;
  seoDescription: string;
};

function presetBlogDraft(topic: string, storeName: string): BlogDraft {
  const clean = topic.trim().replace(/\.$/, "");
  const title = clean
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
  return {
    title,
    excerpt: `A closer look at ${clean.toLowerCase()} from ${storeName}.`,
    body: `At ${storeName}, we get asked about ${clean.toLowerCase()} often enough that it felt worth writing down properly.\n\nCheck back soon for the full guide — in the meantime, browse our current collection and reach out with any questions.`,
    seoTitle: `${title} — ${storeName}`,
    seoDescription: `${title}: what to know, from the team at ${storeName}.`,
  };
}

const BLOG_SYSTEM = [
  "You are EcomAI, writing a blog post for an online store.",
  "Write genuinely useful, specific content for the topic given — not generic filler.",
  "",
  "Shape: 600-900 words. The body is plain text with exactly two kinds of structure: a line starting",
  'with "## " is a subheading, and consecutive lines starting with "- " are bullet items. Everything',
  "else is a paragraph; paragraphs, subheadings and bullet groups are separated by a blank line.",
  "No other markdown — no bold, no links, no single-# headings, no emojis. Use 3-5 \"## \" sections",
  "of 1-3 paragraphs each; bullets only where a list genuinely reads better than prose.",
  "",
  "Keyword: derive ONE primary keyword from the topic — the phrase a searcher would actually type.",
  "The title contains it and is <= 65 characters. The body opens, before the first subheading, with a",
  'one-sentence intro that states that keyword plainly. seoTitle = "Primary Keyword – Store Name",',
  "<= 60 characters total. seoDescription is 120-155 characters with the keyword in its first half.",
  "Use the keyword naturally — never stuff it.",
  "",
  "Close with a short call-to-action paragraph that names one REAL collection or product from the",
  "context below (or the store generally when none was given) — never a made-up one. When the",
  "context lists real products or collections, refer to them by name where they fit the topic;",
  "still don't invent anything about them beyond their names and categories.",
  "",
  "When the context lists existing post titles, don't duplicate one: if the topic is essentially the",
  "same as an existing post, choose a clearly different angle (a different reader, question, or",
  "season) and say what that angle is in the excerpt.",
  "",
  "Warm, confident, concrete — mention real specifics implied by the topic and the store rather than vague generalities.",
  "\"Concrete\" means write with authority in how you explain general, genuinely-true things about the",
  "topic itself (how a material behaves, what to look for, common mistakes) — it does NOT mean",
  "inventing specifics about THIS store or its products that you weren't given: no material,",
  "certification, warranty, guarantee, return policy, sourcing claim, or statistic about the store's",
  "own products unless it's implied by the topic/store name in an obviously generic way. This is",
  "published as a real draft a customer may read — a fabricated claim about the store itself is a",
  "real, durable mistake, not harmless color. When the topic needs a specific store fact to feel",
  "complete, write around it in general terms rather than inventing the specific.",
  "Respond with ONLY JSON using these exact keys:",
  "{",
  '  "title": string,          // <= 65 chars, contains the primary keyword',
  '  "excerpt": string,        // one sentence, shown in the blog list',
  '  "body": string,           // the full post, 600-900 words, "## " subheadings and "- " bullets allowed',
  '  "seoTitle": string,       // "Primary Keyword – Store Name", <= 60 chars',
  '  "seoDescription": string  // 120-155 chars, keyword in the first half',
  "}",
].join("\n");

/**
 * Draft a blog post from a topic — the AI-authored half of the blog system
 * (a merchant can also just write one from scratch; see blog-actions.ts).
 */
/**
 * What the writer knows about the store beyond its name — all optional, all
 * real (read from the store row / its listings / its posts by the caller),
 * so "be specific" and "never invent a store fact" stop contradicting each
 * other (2026-09-07 capability audit, T6/§5.1).
 */
export type BlogContext = {
  about?: string | null;
  tagline?: string | null;
  collections?: string[];
  products?: { title: string; category?: string | null }[];
  existingPostTitles?: string[];
};

export async function generateBlogDraft(
  topic: string,
  storeName: string,
  context?: BlogContext,
): Promise<{ draft: BlogDraft; tokensUsed: number }> {
  if (!isGatewayConfigured() || topic.trim().length < 2) {
    return { draft: presetBlogDraft(topic, storeName), tokensUsed: 0 };
  }

  const ctx: string[] = [`Store: ${storeName}`];
  if (context?.tagline?.trim()) ctx.push(`Tagline: ${context.tagline.trim()}`);
  if (context?.about?.trim()) ctx.push(`About: ${context.about.trim()}`);
  if (context?.collections?.length) ctx.push(`Collections: ${context.collections.slice(0, 10).join(", ")}`);
  if (context?.products?.length) {
    ctx.push(
      `Products on this store (real — name them where they fit): ${context.products
        .slice(0, 30)
        .map((p) => (p.category?.trim() ? `${p.title} (${p.category.trim()})` : p.title))
        .join("; ")}`,
    );
  }
  if (context?.existingPostTitles?.length) {
    ctx.push(
      `Existing blog posts (don't duplicate a topic): ${context.existingPostTitles
        .slice(0, 20)
        .map((t) => JSON.stringify(t))
        .join(", ")}`,
    );
  }
  ctx.push(`Blog post topic: ${topic}`);

  try {
    const { content, tokensUsed } = await chat(
      "workhorse",
      [
        { role: "system", content: BLOG_SYSTEM },
        { role: "user", content: ctx.join("\n") },
      ],
      // reasoningEffort: "none" — see the note in converseBuilder above.
      // maxTokens sized for a 600-900 word body plus the other JSON fields
      // (~2000 tokens); timeout raised to match the longer generation.
      { temperature: 0.7, maxTokens: 2000, responseFormatJson: true, timeoutMs: 30000, reasoningEffort: "none" },
    );
    const p = JSON.parse(content) as Partial<BlogDraft>;
    const base = presetBlogDraft(topic, storeName);
    return {
      draft: {
        title: p.title || base.title,
        excerpt: p.excerpt || base.excerpt,
        body: p.body || base.body,
        seoTitle: p.seoTitle || base.seoTitle,
        seoDescription: p.seoDescription || base.seoDescription,
      },
      tokensUsed,
    };
  } catch {
    return { draft: presetBlogDraft(topic, storeName), tokensUsed: 0 };
  }
}
