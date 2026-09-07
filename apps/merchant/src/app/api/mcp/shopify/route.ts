import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createShopifyMcpServer } from "@/lib/mcp/shopify-server";
import { bearerMatches } from "@/lib/secret-compare";

// Agent tool calls can chain several Shopify Admin API round trips; the
// platform default (10s) isn't enough headroom.
export const maxDuration = 60;

/**
 * Stateless Streamable HTTP: a fresh server + transport per request, no
 * session persistence. Correct for a serverless deployment target — nothing
 * here relies on the process staying warm between calls.
 */

/**
 * These MCP servers execute against the service-role client (Shopify writes)
 * and an RLS-bypassing read replica (SQL). They are for trusted agent hosts
 * only: every request must carry `Authorization: Bearer $MCP_SERVER_SECRET`.
 * With the secret unset the routes do not exist.
 */
function gate(req: Request): Response | null {
  const secret = process.env.MCP_SERVER_SECRET;
  if (!secret) return new Response("Not found", { status: 404 });
  if (!bearerMatches(req, secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function handle(req: Request): Promise<Response> {
  const denied = gate(req);
  if (denied) return denied;
  const server = createShopifyMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as GET, handle as POST, handle as DELETE };
