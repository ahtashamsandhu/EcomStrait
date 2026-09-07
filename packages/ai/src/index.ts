export type { ChatMessage, ChatOptions, ChatResult, EmbeddingResult, ModelRole } from "./types";
export { resolveModel, isRoleConfigured } from "./roles";
export { chat, embed, isGatewayConfigured } from "./gateway";
export {
  embedText,
  embedBatch,
  upsertEmbedding,
  upsertEmbeddings,
  retrieve,
  GLOBAL_TENANT_ID,
  type EmbeddingSource,
  type RetrievedChunk,
  type RetrieveOptions,
} from "./rag";
export {
  createChatModel,
  createBusinessAdvisorAgent,
  createAnalyticsAgent,
  runOrchestrator,
  contentToText,
  sumUsage,
  decideRestock,
  currentDateLine,
  METRIC_DEFINITIONS,
  SQL_EXAMPLES,
  type OrchestratorInput,
  type OrchestratorResult,
  type RestockInput,
  type RestockDecision,
} from "./agents";
export {
  requestApproval,
  getApproval,
  resolveApproval,
  recordUsage,
  assertCostBudget,
  getOrComputeSnapshot,
  type Approval,
  type ApprovalStatus,
} from "./guardrails";
export {
  loadChatThread,
  appendChatTurns,
  clearChatThread,
  type ChatThreadMessage,
  type ChatAgent,
} from "./memory/chat-threads";
