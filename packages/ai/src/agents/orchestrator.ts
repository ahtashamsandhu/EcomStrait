import "server-only";

import { Annotation, StateGraph, START, END, MessagesAnnotation } from "@langchain/langgraph";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createAdminClient } from "@ecomstrait/db/admin";
import { createChatModel } from "./model";
import { createBusinessAdvisorAgent } from "./business-advisor";
import { createAnalyticsAgent } from "./analytics-agent";
import { assertCostBudget, recordUsage } from "../guardrails/cost";
import { resolveModel } from "../roles";

type Route = "advisor" | "analytics";

/**
 * `BaseMessage.content` is `string | MessageContentComplex[]` — a plain
 * string for most providers, but an array of content parts for others (the
 * gateway's "fast-cheap" role, in particular: routing it through
 * `String(content)` silently produced the literal text "[object Object]"
 * for every message, which never matched any classification keyword, so the
 * router always fell through to "advisor" regardless of what was asked.
 * Extracting text parts explicitly is what actually fixes that, not a
 * `String()`/`JSON.stringify()` fallback that merely looks like it works.
 */
export function contentToText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
    .join("");
}

const OrchestratorState = Annotation.Root({
  ...MessagesAnnotation.spec,
  route: Annotation<Route>(),
});

export type OrchestratorInput = {
  tenantId: string;
  /** Scopes the conversation — one per store keeps this simple for now. */
  threadId: string;
  message: string;
  /** App-specific tools (e.g. Shopify) injected into the Business Advisor. */
  extraTools?: StructuredToolInterface[];
  /**
   * Identifying facts about what "this store"/"this tenant" means (name,
   * id, domain, etc.), injected as a system message. Without this the agent
   * can see rows in the database but has no way to tell which one it's
   * being asked about — it correctly refuses to guess rather than
   * attributing data to the wrong store, which is safe but useless. Callers
   * that know the store's identity (e.g. `apps/merchant`) should always
   * pass this.
   */
  context?: string;
  /**
   * Prior turns of this thread, oldest first, so "and last week?" or "same
   * for the other product" has something to refer to. Only the last
   * `HISTORY_MAX_TURNS` are used, each capped at `HISTORY_MAX_CHARS`; the
   * caller is expected to load these from `ai_agent_runs` (or its own chat
   * memory) — this package never reads them back itself.
   */
  history?: OrchestratorHistoryTurn[];
};

export type OrchestratorHistoryTurn = { role: "user" | "assistant"; content: string };

/** Last N prior turns handed to the specialist; older ones are dropped. */
const HISTORY_MAX_TURNS = 8;
/** Per-turn cap — a long advisor reply shouldn't crowd out the new question. */
const HISTORY_MAX_CHARS = 2000;
/** How many prior *user* turns the router sees as context. */
const ROUTER_HISTORY_USER_TURNS = 2;

function trimHistory(history: OrchestratorHistoryTurn[] | undefined): OrchestratorHistoryTurn[] {
  return (history ?? [])
    .filter((t) => typeof t.content === "string" && t.content.trim())
    .slice(-HISTORY_MAX_TURNS)
    .map((t) => ({ role: t.role, content: t.content.length > HISTORY_MAX_CHARS ? t.content.slice(0, HISTORY_MAX_CHARS) + " …" : t.content }));
}

export type OrchestratorResult = {
  reply: string;
  route: Route;
  /** Null if the DB write failed — the reply still returns; a broken audit
   *  trail must never block the answer the merchant is waiting for. */
  agentRunId: string | null;
};

/**
 * The orchestrator: classifies a merchant's message, hands it to whichever
 * specialist agent fits, and persists a trace of the run.
 *
 * Built as an actual LangGraph `StateGraph` (router node -> conditional edge
 * -> one of two agent nodes) rather than a hand-rolled if/else, so this is a
 * real multi-agent handoff, not routing dressed up as one — the graph
 * structure is what Phase 4 in Docs/AI-Native-Migration-Plan.md set out to
 * prove.
 */
export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorResult> {
  // Checked before any model call, not after — a tenant over budget never
  // reaches the model at all, same principle as `assertTokenBudget` in
  // apps/merchant/src/lib/entitlements.ts. No run is persisted here: nothing
  // actually happened, so there's nothing to audit.
  const budget = await assertCostBudget(input.tenantId);
  if (!budget.ok) {
    return { reply: budget.error, route: "advisor", agentRunId: null };
  }

  const router = createChatModel("fast-cheap", { temperature: 0 });
  const history = trimHistory(input.history);

  // All nodes are declared before any edge referencing them — the fluent
  // builder infers each `addNode`'s node-name type incrementally, so an edge
  // or conditional-edge call only "sees" nodes added earlier in the chain.
  const graph = new StateGraph(OrchestratorState)
    .addNode("router", async (state) => {
      const last = state.messages[state.messages.length - 1];
      const question = last ? contentToText(last.content) : "";
      // A fragment like "and last week?" only classifies correctly with the
      // turn(s) it continues — give the router the last couple of prior user
      // turns as brief context, but keep the message it classifies distinct.
      const priorUserTurns = history
        .filter((t) => t.role === "user")
        .slice(-ROUTER_HISTORY_USER_TURNS)
        .map((t) => (t.content.length > 300 ? t.content.slice(0, 300) + " …" : t.content));
      const routerInput = priorUserTurns.length
        ? `Earlier the merchant asked: ${priorUserTurns.map((t) => JSON.stringify(t)).join(" then ")}\n\nNow classify this message: ${question}`
        : question;
      const decision = await router.invoke([
        {
          role: "system",
          content: [
            'Classify the merchant\'s message as "analytics" (asking about sales, orders, revenue, ',
            'numbers, or performance) or "advisor" (general business advice, product, marketing, or ',
            'strategy questions — this includes any question that also needs a recommendation or ',
            "judgment call, even one that starts from a number, since the advisor has the same SQL query ",
            "tool available and can look the number up itself before advising).\n",
            "Examples:\n",
            '"What was my total revenue last month?" -> analytics (a pure numbers question, nothing to ',
            "recommend)\n",
            '"How many orders came in this week?" -> analytics (a pure numbers question)\n',
            '"How can I get more repeat customers?" -> advisor (strategy/advice, no specific number ',
            "needed)\n",
            '"Why did my revenue drop last month, and what should I do about it?" -> advisor (mixed/',
            "ambiguous case: it needs a real number to open with, but also a recommendation — route the ",
            "whole thing to advisor rather than splitting one question across two specialists, since ",
            "advisor can query the same data itself)\n",
            "If the message is preceded by \"Earlier the merchant asked:\", that is context only — classify ",
            "the message after \"Now classify this message:\" in light of it (a fragment like \"and last ",
            "week?\" after a revenue question is analytics).\n",
            "Reply with exactly one word: analytics or advisor.",
          ].join(""),
        },
        { role: "user", content: routerInput },
      ]);
      const text = contentToText(decision.content).toLowerCase();
      return { route: (text.includes("analytics") ? "analytics" : "advisor") as Route };
    })
    .addNode("business_advisor", async (state) => {
      const agent = createBusinessAdvisorAgent({ tenantId: input.tenantId, extraTools: input.extraTools });
      const result = await agent.invoke({ messages: state.messages });
      return { messages: result.messages };
    })
    .addNode("analytics_agent", async (state) => {
      const agent = createAnalyticsAgent();
      const result = await agent.invoke({ messages: state.messages });
      return { messages: result.messages };
    })
    .addEdge(START, "router")
    .addConditionalEdges("router", (state) => state.route, {
      advisor: "business_advisor",
      analytics: "analytics_agent",
    })
    .addEdge("business_advisor", END)
    .addEdge("analytics_agent", END)
    .compile();

  // System context first, then prior turns (oldest first) as plain
  // Human/AI messages, then the new question — so the specialist sees the
  // conversation it's continuing, not just one message (audit T5, 6.2, 7.6).
  const historyMessages: BaseMessage[] = history.map((t) =>
    t.role === "user" ? new HumanMessage(t.content) : new AIMessage(t.content),
  );
  const initialMessages: BaseMessage[] = [
    ...(input.context ? [new SystemMessage(input.context)] : []),
    ...historyMessages,
    new HumanMessage(input.message),
  ];

  const final = await graph.invoke({ messages: initialMessages, route: "advisor" });

  // Observed in testing: after a correct multi-step tool chain (including
  // self-correcting a wrong column name), the model's final synthesis turn
  // came back with genuinely empty content — no tool call, no text. Rare,
  // but a blank reply reaching the merchant is worse than an honest one
  // saying the answer didn't come through, especially after real work
  // happened (visible in the persisted tool_calls trace either way).
  let finalMessages = final.messages;
  let lastMessage = finalMessages[finalMessages.length - 1];
  let rawReply = lastMessage ? contentToText(lastMessage.content) : "";

  if (!rawReply.trim()) {
    // One retry before giving up: drop the empty AIMessage and hand the rest
    // of the transcript (including any tool calls/results already made) back
    // to the same specialist for another synthesis attempt. This re-runs the
    // agent's loop rather than poking the raw model, but since the messages
    // already end in a ToolMessage/HumanMessage (never a dangling tool call),
    // it costs one more completion, not a repeat of the whole tool chain.
    try {
      const retryMessages = finalMessages.slice(0, -1);
      const retryAgent =
        final.route === "analytics"
          ? createAnalyticsAgent()
          : createBusinessAdvisorAgent({ tenantId: input.tenantId, extraTools: input.extraTools });
      const retryResult = await retryAgent.invoke({ messages: retryMessages });
      finalMessages = retryResult.messages;
      lastMessage = finalMessages[finalMessages.length - 1];
      rawReply = lastMessage ? contentToText(lastMessage.content) : "";
    } catch (err) {
      console.error("[ai] orchestrator retry of final synthesis failed:", err);
    }
  }

  const reply =
    rawReply.trim() ||
    "I looked into that but couldn't put together a clear answer — could you try rephrasing the question?";

  const agentRunId = await persistAgentRun({
    tenantId: input.tenantId,
    threadId: input.threadId,
    agent: final.route === "analytics" ? "analytics-agent" : "business-advisor",
    input: { message: input.message, context: input.context },
    output: { reply },
    toolCalls: extractToolCalls(finalMessages),
  });

  // One ledger entry per run, not per model call: this folds the router's
  // (fast-cheap) usage in with the chosen agent's (reasoning/workhorse) —
  // an approximation, not a per-call breakdown, but real token volume per
  // role is still the signal a future model-swap decision needs. Includes
  // the retry's usage too, when one happened.
  const agentRole = final.route === "analytics" ? "workhorse" : "reasoning";
  const usage = sumUsage(finalMessages);
  await recordUsage({
    tenantId: input.tenantId,
    role: agentRole,
    model: resolveModel(agentRole),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  return { reply, route: final.route, agentRunId };
}

export function sumUsage(messages: BaseMessage[]): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const m of messages) {
    if (m instanceof AIMessage && m.usage_metadata) {
      inputTokens += m.usage_metadata.input_tokens ?? 0;
      outputTokens += m.usage_metadata.output_tokens ?? 0;
    }
  }
  return { inputTokens, outputTokens };
}

/**
 * A simplified, JSON-safe trace of what the agent actually did — matched by
 * `tool_call_id`, since messages don't arrive call-then-result adjacent when
 * the model batches several calls in one turn.
 */
function extractToolCalls(messages: BaseMessage[]): { tool: string; args: unknown; result?: string }[] {
  const resultById = new Map<string, string>();
  for (const m of messages) {
    if (m instanceof ToolMessage) {
      resultById.set(m.tool_call_id, typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    }
  }
  const calls: { tool: string; args: unknown; result?: string }[] = [];
  for (const m of messages) {
    if (m instanceof AIMessage) {
      for (const tc of m.tool_calls ?? []) {
        calls.push({ tool: tc.name, args: tc.args, result: tc.id ? resultById.get(tc.id) : undefined });
      }
    }
  }
  return calls;
}

async function persistAgentRun(params: {
  tenantId: string;
  threadId: string;
  agent: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  toolCalls: unknown[];
}): Promise<string | null> {
  const client = createAdminClient();
  if (!client) return null;

  const { data, error } = await client
    .from("ai_agent_runs")
    .insert({
      tenant_id: params.tenantId,
      agent: params.agent,
      thread_id: params.threadId,
      status: "done",
      input: params.input,
      output: params.output,
      tool_calls: params.toolCalls,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[ai] failed to persist agent run:", error.message);
    return null;
  }
  return data?.id ?? null;
}
