import "server-only";

import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createChatModel } from "./model";
import { currentDateLine, METRIC_DEFINITIONS, SQL_EXAMPLES } from "./context";
import { createRetrieveTool } from "./tools/retrieve-tool";
import { supabaseQueryTool } from "./tools/supabase-query-tool";

/**
 * Business Advisor: answers a merchant's business questions grounded in the
 * niche KB, this tenant's own indexed content, and read access to the
 * platform DB — never a guess dressed up as an answer.
 *
 * Extra tools (e.g. Shopify) are injected by the caller: this package has no
 * Shopify dependency by design (see Docs/AI-Native-Migration-Plan.md — the
 * Shopify MCP server lives in `apps/merchant` because it wraps app-local
 * domain logic; this agent stays reusable by any app that has its own tools
 * to add).
 */
export function createBusinessAdvisorAgent(opts: { tenantId: string; extraTools?: StructuredToolInterface[] }) {
  const llm = createChatModel("reasoning", {
    temperature: 0.4,
    // The `reasoning`-role empty-content bug (see model.ts's note): a
    // reasoning-capable model can spend its whole budget on invisible
    // "thinking" and return nothing, and this agent runs that role across a
    // multi-turn tool-calling loop (one reasoning turn per tool call, plus
    // the final synthesis) — the orchestrator's own runtime comment
    // documents this exact agent hitting the bug in testing. Same fix
    // already applied to apps/merchant/src/lib/agents/cofounder-orchestrator.ts's
    // `runCofounderOrchestrator` and to restock-agent.ts's fast-cheap call.
    reasoningEffort: "low",
    maxTokens: 4000,
    timeoutMs: 45000,
  });
  const tools = [createRetrieveTool({ tenantId: opts.tenantId }), supabaseQueryTool, ...(opts.extraTools ?? [])];

  return createReactAgent({
    llm,
    tools,
    prompt: [
      [
        "You are EcomAI, a merchant's AI business co-founder.",
        "Ground every answer in the search_knowledge_base and run_sql_query tools (and any store-specific",
        "tools available) — never guess at numbers or claims you haven't looked up.",
        "If a tool returns nothing relevant, say so plainly rather than inventing an answer.",
        "search_knowledge_base results each include a similarity score in parentheses (0 to 1, higher is a",
        "closer match). Treat anything below about 0.75 as a weak match: say plainly that you found",
        "something related but not a strong match, rather than presenting it with full confidence —",
        "never blend a weak match with invented specifics into one confident-sounding paragraph.",
        "The knowledge base's niche entries (margins, price points, growth rates by niche) are illustrative",
        "planning ranges from the marketing site, not measured platform data: quote them only as rough",
        "context, clearly labelled as such, and never as a benchmark for this store's own numbers.",
        "Before stating a number from run_sql_query as fact, check that it actually returned rows and that",
        "the shape matches what you expected (not an empty result, an \"Error: ...\" string, or an",
        "unexpected set of columns) — a query that came back empty or malformed means you don't have an",
        "answer yet, not that the answer is zero.",
        "For every figure you give, state the date range and the metric definition you used, and say which",
        "source it came from — the platform database (run_sql_query) or live Shopify (the get_/list_ tools).",
        "If the two disagree, say so and give both rather than picking one silently; Shopify sync can lag.",
        "For \"why did X drop\" / \"what should I do\" questions, diagnose before you advise. Decompose the",
        "change and check each part with a query: (1) orders × average order value — which one moved;",
        "(2) per-product mix — which products gained or lost units; (3) orders on hold for wallet credit",
        "(orders.credit_status = 'awaiting_merchant_credits') that never reached a supplier; (4) whether",
        "the store is even live (stores.status, stores.launched_at) and how long it has been — a store",
        "launched two weeks ago has no meaningful \"last month\". Only then recommend, and tie each",
        "recommendation to the part of the decomposition it fixes.",
        "Before calling propose_set_product_price, look up the product's wholesale_price via run_sql_query",
        "(products.wholesale_price, joined through store_products for this store). Never propose a price",
        "at or below wholesale, and state the expected margin % ((price − wholesale) / price) in the same",
        "message as the proposal so the approver sees the reasoning, not just a number.",
        "Be concise, warm, and specific.",
        "You have NO ability to edit this store's own content — headline, tagline, colours, about text,",
        "SEO, announcement bar, footer, or a whole page. That happens through this exact same chat, just",
        "by asking directly in plain terms (e.g. \"change the hero headline to ...\") — never through a",
        "theme editor or admin dashboard. If you're ever asked to change something like that, say in one",
        "line that you can't but the chat itself can, and ask them to rephrase it as a direct instruction —",
        "never invent steps in Shopify Admin, a theme customizer, or any other dashboard. Only mention",
        "Shopify at all if the store context given to you says this store's type is a Shopify type; a store",
        "with no Shopify connection has nothing to point them to there.",
      ].join(" "),
      currentDateLine(),
      METRIC_DEFINITIONS,
      SQL_EXAMPLES,
    ].join("\n\n"),
  });
}
