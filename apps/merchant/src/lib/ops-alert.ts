import "server-only";
import { createAdminClient } from "@ecomstrait/db/admin";

/**
 * Operational alerts to the EcomStrait team.
 *
 * A pool store with a rejected token blocks every merchant who tries to
 * provision, and merchants can't fix it — they have no access to those shops.
 * Waiting for someone to open the admin panel isn't good enough, so first
 * detection sends an email.
 *
 * Best-effort throughout: a failure to alert must never fail the merchant's
 * action, which is already degraded.
 */

const RECONNECT_FLAG = "reconnect needed";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendOpsEmail(subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.OPS_ALERT_EMAIL || process.env.LEAD_NOTIFY_EMAIL;
  if (!key || !to) return false;
  const from = process.env.RESEND_FROM || "EcomStrait <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Mark a pool store as needing reconnection, alerting the team the first time.
 *
 * `sync_status` doubles as the dedupe key: a store already flagged doesn't send
 * another email, so a merchant retrying ten times doesn't produce ten alerts.
 */
export async function flagReconnectNeeded(
  shopifyStoreId: string,
  shopDomain: string,
  reason = "Shopify rejected the stored access token",
): Promise<void> {
  const admin = createAdminClient();
  if (!admin) return;

  try {
    const { data: current } = await admin
      .from("shopify_stores")
      .select("sync_status")
      .eq("id", shopifyStoreId)
      .maybeSingle();

    const alreadyFlagged = current?.sync_status?.toLowerCase().includes(RECONNECT_FLAG) ?? false;

    await admin
      .from("shopify_stores")
      .update({ sync_status: `${RECONNECT_FLAG} — ${reason}` })
      .eq("id", shopifyStoreId);

    if (alreadyFlagged) return;

    const shopName = shopDomain.split(".")[0];
    await sendOpsEmail(
      `[EcomStrait] Reconnect needed: ${shopDomain}`,
      `<p><strong>${escapeHtml(shopDomain)}</strong> can no longer be reached.</p>
       <p>${escapeHtml(reason)}.</p>
       <p>Merchants can't fix this — they have no access to this shop. Open the EcomStrait app
       on it once to restore access:</p>
       <p><a href="https://admin.shopify.com/store/${escapeHtml(shopName)}/apps">
       Open ${escapeHtml(shopName)} apps</a></p>
       <p>Provisioning and product sync stay blocked for this store until it's reconnected.</p>`,
    );
  } catch {
    // Alerting is never allowed to break the caller.
  }
}

/**
 * Warn the team when a supplier's price rise leaves a fixed listing below cost.
 *
 * The merchant set that price deliberately, so we don't overwrite it — but a
 * listing selling under wholesale loses money on every order, and merchants
 * have no in-app alerting yet.
 */
export async function alertListingBelowCost(
  productTitle: string,
  listings: { storeId: string; price: number }[],
  cost: number,
): Promise<void> {
  if (!listings.length) return;
  try {
    const rows = listings
      .map(
        (l) =>
          `<li>Store <code>${escapeHtml(l.storeId)}</code> — selling at ${l.price.toFixed(2)}</li>`,
      )
      .join("");
    await sendOpsEmail(
      `[EcomStrait] Listing below cost: ${productTitle}`,
      `<p>The supplier raised the cost of <strong>${escapeHtml(productTitle)}</strong> to
       ${cost.toFixed(2)}, but these listings have a merchant-set price below that and were
       left unchanged:</p>
       <ul>${rows}</ul>
       <p>Each sale on them loses money. Contact the merchant, or adjust the listing price.</p>`,
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Tell the team an AI restock recommendation is waiting for a decision.
 *
 * The approval this refers to only takes effect once someone resolves it via
 * /api/admin/approvals/[id] — no supplier-facing approval UI exists yet, so
 * ops is the only audience able to act on it today.
 */
export async function alertRestockRecommended(
  productTitle: string,
  quantity: number,
  reasoning: string,
  approvalId: string,
): Promise<void> {
  try {
    await sendOpsEmail(
      `[EcomStrait] Restock recommended: ${productTitle}`,
      `<p>EcomAI recommends restocking <strong>${escapeHtml(productTitle)}</strong> by
       <strong>${quantity}</strong> units.</p>
       <p>${escapeHtml(reasoning)}</p>
       <p>Approval id: <code>${escapeHtml(approvalId)}</code> — nothing has changed yet;
       this needs a decision via the approvals endpoint.</p>`,
    );
  } catch {
    /* best-effort */
  }
}

/** Tell the team the pool has run dry — no merchant can provision until it's refilled. */
export async function alertPoolEmpty(reason: string): Promise<void> {
  const admin = createAdminClient();
  if (!admin) return;
  try {
    // Only worth an alert if someone actually wanted a store and couldn't get one.
    await sendOpsEmail(
      "[EcomStrait] Store pool is empty",
      `<p>A merchant tried to provision a Shopify store and none was available.</p>
       <p>${escapeHtml(reason)}</p>
       <p>Add dev stores to the pool, or reconnect the ones flagged in the admin panel.</p>`,
    );
  } catch {
    /* best-effort */
  }
}
