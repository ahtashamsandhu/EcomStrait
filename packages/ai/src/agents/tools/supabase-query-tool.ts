import "server-only";

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { runReadOnlyQuery } from "../../mcp/supabase-query";

/**
 * The same read-only query guard as the Supabase MCP server
 * (`../../mcp/supabase-server.ts`), wrapped as a LangChain tool for agents
 * that call it directly (in-process, no HTTP round trip) rather than through
 * the MCP protocol.
 */
export const supabaseQueryTool = tool(
  async ({ sql, params }: { sql: string; params?: (string | number | boolean | null)[] }) => {
    const result = await runReadOnlyQuery(sql, params ?? []);
    return result.ok ? JSON.stringify(result.rows) : `Error: ${result.error}`;
  },
  {
    name: "run_sql_query",
    description:
      "Run a parameterized, read-only (SELECT/WITH) SQL query against the platform database. " +
      "Use $1, $2, ... placeholders in `sql` and pass their values in `params`, in order. " +
      "Aggregate in SQL (SUM/COUNT/GROUP BY); results are capped at 100 rows, so a row-list you count " +
      "yourself is silently incomplete. " +
      "Schema — table: columns (tenant-scoping column called out in parens; always filter on it using " +
      "the tenant/store id given in the question, never join or return rows across tenants):\n" +
      "- stores (scope: user_id, the merchant/owner's user id): id, user_id, name, type " +
      "('shopify_shopify_theme'|'shopify_liquid_theme'|'own_platform'), status, domain, subdomain, " +
      "shopify_store_id, launched_at (when the store went live; null = not yet launched), created_at.\n" +
      "- store_orders, a merchant's own storefront checkout (scope: store_id -> stores.id): id, store_id, " +
      "customer_name, customer_email, subtotal, items (jsonb array of {product_id, supplier_id, name, " +
      "quantity, unit_price} — no separate line-items table for this order type), status, created_at.\n" +
      "- store_products, one row per store's listing decision on a supplier product (scope: store_id -> " +
      "stores.id): store_id, product_id -> products.id, supplier_id, price, status " +
      "('pending'|'approved'|'declined'), created_at. Join stores<->products through this table.\n" +
      "- products, a supplier's catalog item — NOT store-specific on its own (scope: supplier_id -> " +
      "suppliers.id; go through store_products to scope to one store): id, supplier_id, title, stock, " +
      "low_stock_threshold, wholesale_price, retail_price, status ('draft'|'published'), created_at.\n" +
      "- suppliers (scope: owner_user_id, the supplier's own user id): id, owner_user_id, business_name, " +
      "status ('pending'|'in_review'|'approved'|'rejected'), created_at.\n" +
      "- orders, the supplier-fulfillment side of a checkout — one row per supplier per store_orders " +
      "checkout (scope: supplier_id -> suppliers.id, OR store_id -> stores.id for the merchant's side; " +
      "store_id is nullable and does not backfill old rows): id, number, supplier_id, store_id, " +
      "store_order_id (back-link to the store_orders row this was split from), status " +
      "('processing'|'shipped'|'delivered'|'cancelled'), cost_amount, margin_amount, " +
      "platform_fee_amount, created_at.\n" +
      "- order_items, line items of `orders` (no tenant column of its own — scope by joining orders.id): " +
      "order_id -> orders.id, product_id, product_name, quantity, unit_price.",
    schema: z.object({
      sql: z.string(),
      params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    }),
  },
);
