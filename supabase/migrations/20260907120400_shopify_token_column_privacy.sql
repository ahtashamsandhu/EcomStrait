-- ============================================================================
--  Security hardening 5 — Shopify Admin API tokens are never readable by a
--  browser session.
--
--  `shopify_stores_owner_select` let the assigned merchant's session read the
--  whole row, `access_token` included — so any XSS on the dashboard origin
--  was a full Shopify API takeover. Every app path that needs the token runs
--  with the service role; the one session read (the merchant's Stores page)
--  selects named columns. Table-level SELECT is therefore replaced by
--  column-level SELECT on everything except the token.
--
--  (At-rest encryption of the token is a separate, larger change: every
--  reader would need the key. Tracked in the audit report as still open.)
-- ============================================================================
revoke select on public.shopify_stores from anon, authenticated;
grant select (
  id, shop_domain, shopify_shop_id, scopes, status, owner_user_id, assigned_at,
  transferred_at, theme_id, sync_status, notes, created_at, updated_at,
  storefront_password, transfer_email, transfer_requested_at
) on public.shopify_stores to authenticated;

-- Admin-panel writes go through the service role; a session (even an admin
-- profile) has no reason to write this table directly any more.
revoke insert, update, delete on public.shopify_stores from anon, authenticated;

notify pgrst, 'reload schema';
