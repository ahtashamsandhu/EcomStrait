import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { requestApproval } from "@ecomstrait/ai";

/**
 * Write actions, gated behind human approval (Phase 5,
 * Docs/AI-Native-Migration-Plan.md).
 *
 * These tools never call `setShopifyProductPrice`/`setShopifyProductStatus`
 * directly — they only create a pending `ai_approvals` row and tell the
 * merchant a human needs to approve it. The actual Shopify write happens
 * only when someone resolves that approval as "approved" — see
 * `app/api/admin/approvals/[id]/route.ts`, the one place these two Shopify
 * functions actually get called with agent-proposed arguments.
 */
export function createShopifyWriteTools(opts: { tenantId: string; storeId: string }) {
  const proposeSetPrice = tool(
    async ({ productGid, price, rationale }: { productGid: string; price: number; rationale?: string }) => {
      const approval = await requestApproval({
        tenantId: opts.tenantId,
        threadId: opts.storeId,
        action: "shopify.set_product_price",
        // `rationale` rides along in the payload so the approver sees the
        // reasoning (wholesale floor, expected margin) next to the number;
        // the approval route only reads storeId/productGid/price from it.
        payload: { storeId: opts.storeId, productGid, price, ...(rationale ? { rationale } : {}) },
      });
      const why = rationale ? ` Rationale recorded with the request: ${rationale}` : "";
      return `I've requested approval to set this product's price to $${price} (approval id: ${approval.id}). Nothing has changed yet — a human needs to approve this first.${why}`;
    },
    {
      name: "propose_set_product_price",
      description:
        "Propose changing a product's price. Requires human approval — does not change anything immediately. " +
        "Look up the product's wholesale_price (products.wholesale_price via run_sql_query) first: never propose " +
        "a price at or below wholesale. Pass `rationale` with the wholesale price and the expected margin % " +
        "((price - wholesale) / price) so the approver sees why, not just the number.",
      schema: z.object({
        productGid: z.string(),
        price: z.number().positive(),
        rationale: z.string().optional(),
      }),
    },
  );

  const proposeSetStatus = tool(
    async ({ productGid, status }: { productGid: string; status: "ACTIVE" | "DRAFT" }) => {
      const approval = await requestApproval({
        tenantId: opts.tenantId,
        threadId: opts.storeId,
        action: "shopify.set_product_status",
        payload: { storeId: opts.storeId, productGid, status },
      });
      const verb = status === "ACTIVE" ? "publish" : "hide";
      return `I've requested approval to ${verb} this product (approval id: ${approval.id}). Nothing has changed yet — a human needs to approve this first.`;
    },
    {
      name: "propose_set_product_status",
      description:
        "Propose publishing or hiding a product. Requires human approval — does not change anything immediately.",
      schema: z.object({ productGid: z.string(), status: z.enum(["ACTIVE", "DRAFT"]) }),
    },
  );

  return [proposeSetPrice, proposeSetStatus];
}
