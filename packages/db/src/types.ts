/** Platform roles (RBAC — Doc 14). Extend as new roles are introduced. */
export type UserRole =
  | "admin"
  | "supplier"
  | "supplier_staff"
  | "business_owner"
  | "customer";

export type SupplierStatus = "pending" | "in_review" | "approved" | "rejected";
export type ProductStatus = "draft" | "published";
/** A merchant's request to list one supplier product on one of their stores. */
export type ListingStatus = "pending" | "approved" | "declined";
export type ProductVariant = { name: string; options: string[] };
export type RequestStatus = "new" | "accepted" | "declined" | "proposed" | "fulfilled";
export type MessageSender = "supplier" | "store_owner" | "system";
export type OrderStatus = "processing" | "shipped" | "delivered" | "cancelled";
/** Synthetic-for-now (see `store_traffic_events.is_synthetic`) attribution of an order to a channel. */
export type TrafficSource = "organic_search" | "paid_search" | "social" | "direct" | "referral" | "email";
/** Docs/Credits-Settlement-Plan.md — merchant wallet (pooled per user) vs supplier wallet. */
export type WalletAccountType = "merchant" | "supplier";
export type WalletTransactionKind =
  | "topup"
  | "order_deduction"
  | "order_credit"
  | "reversal"
  | "settlement_payout";
/** Who collected the customer's money: the merchant (Shopify checkout) or the
 *  supplier (COD, collected at delivery). Decides which wallet gets debited. */
export type OrderPaymentType = "prepaid" | "cod";
export type OrderCreditStatus =
  | "deducted"
  | "awaiting_merchant_credits"
  | "awaiting_supplier_credits"
  | "reversed";
export type PayableStatus = "pending" | "settled" | "paid_out";
export type SettlementBatchStatus = "draft" | "paid";
export type PayoutRequestStatus = "pending" | "paid" | "declined";
export type PlanTier = "free" | "basic" | "premium" | "full";
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete";
export type StoreType = "shopify_shopify_theme" | "shopify_liquid_theme" | "own_platform";
export type StoreStatus = "draft" | "building" | "ready_for_review" | "live" | "archived";
export type PostStatus = "draft" | "published";
/** Who wrote the current draft — doesn't gate what a merchant can do with it. */
export type PostSource = "ai" | "merchant";
export type ShopifyStoreStatus =
  | "available"
  | "assigned"
  | "building"
  | "ready_for_review"
  | "client_approved"
  | "waiting_for_transfer"
  | "transferred"
  | "archived";
export type DocumentType =
  | "business_registration"
  | "tax_registration"
  | "national_id"
  | "company_logo"
  | "address_proof";

/**
 * Typed schema for the Supabase client. Grow this table-by-table as the schema
 * lands (or generate via `supabase gen types typescript`).
 */
export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          user_id: string;
          role: UserRole;
          full_name: string | null;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: { user_id: string; role?: UserRole; full_name?: string | null; avatar_url?: string | null };
        Update: { role?: UserRole; full_name?: string | null; avatar_url?: string | null };
        Relationships: [];
      };
      suppliers: {
        Row: {
          id: string;
          owner_user_id: string;
          business_name: string | null;
          business_type: string | null;
          contact_person: string | null;
          phone: string | null;
          country: string | null;
          city: string | null;
          website: string | null;
          years_in_business: string | null;
          product_categories: string[];
          number_of_products: string | null;
          manufacturing_type: string | null;
          description: string | null;
          estimated_inventory_size: string | null;
          average_lead_time: string | null;
          shipping_regions: string[];
          min_order_quantity: string | null;
          marketing_opt_in: boolean;
          terms_accepted_at: string | null;
          status: SupplierStatus;
          onboarding_step: number;
          quality_score: number | null;
          /** Set when an admin returns the application for edits — checked
           *  items from RETURN_CHECKLIST (apps/supplier/src/lib/onboarding.ts)
           *  plus an optional free-text note, both cleared on the next
           *  approval or resubmission. See
           *  supabase/migrations/20260902110000_supplier_return_feedback.sql. */
          return_reasons: string[];
          return_note: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          owner_user_id: string;
        } & Partial<Omit<Database["public"]["Tables"]["suppliers"]["Row"], "owner_user_id">>;
        Update: Partial<Database["public"]["Tables"]["suppliers"]["Row"]>;
        Relationships: [];
      };
      supplier_verification: {
        Row: {
          supplier_id: string;
          email_verified_at: string | null;
          phone_verified_at: string | null;
          documents_verified_at: string | null;
          manual_reviewed_at: string | null;
          badge_granted_at: string | null;
          updated_at: string;
        };
        Insert: { supplier_id: string } & Partial<
          Database["public"]["Tables"]["supplier_verification"]["Row"]
        >;
        Update: Partial<Database["public"]["Tables"]["supplier_verification"]["Row"]>;
        Relationships: [];
      };
      supplier_documents: {
        Row: {
          id: string;
          supplier_id: string;
          type: DocumentType;
          storage_path: string;
          status: "uploaded" | "verified" | "rejected";
          created_at: string;
        };
        Insert: {
          supplier_id: string;
          type: DocumentType;
          storage_path: string;
          status?: "uploaded" | "verified" | "rejected";
        };
        Update: Partial<Database["public"]["Tables"]["supplier_documents"]["Row"]>;
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          supplier_id: string;
          title: string;
          description: string | null;
          category: string | null;
          images: string[];
          sku: string | null;
          wholesale_price: number | null;
          /** Functions as MSRP — a supplier-set reference price, never
           *  enforced on its own (only used to compute the storefront's
           *  "was $X" markdown display). */
          retail_price: number | null;
          /** Minimum advertised price — a hard floor, unlike retail_price.
           *  Enforced by a DB trigger on store_products, not just app code.
           *  See supabase/migrations/20260902120000_products_map_price.sql. */
          map_price: number | null;
          stock: number;
          reserved: number;
          low_stock_threshold: number;
          status: ProductStatus;
          seo_title: string | null;
          seo_description: string | null;
          /** Human-readable size list, e.g. "6, 7, 8, 9, 10" — informational
           *  display only, not wired into `variants`/checkout. */
          sizes: string | null;
          material: string | null;
          /** Short fit guidance, e.g. "Runs true to size". */
          fit_note: string | null;
          variants: ProductVariant[];
          created_at: string;
          updated_at: string;
        };
        Insert: {
          supplier_id: string;
          title: string;
        } & Partial<Omit<Database["public"]["Tables"]["products"]["Row"], "supplier_id" | "title">>;
        Update: Partial<Database["public"]["Tables"]["products"]["Row"]>;
        Relationships: [];
      };
      inventory_adjustments: {
        Row: {
          id: string;
          product_id: string;
          delta: number;
          reason: string | null;
          resulting_stock: number;
          created_at: string;
        };
        Insert: {
          product_id: string;
          delta: number;
          resulting_stock: number;
          reason?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["inventory_adjustments"]["Row"]>;
        Relationships: [];
      };
      product_requests: {
        Row: {
          id: string;
          supplier_id: string;
          store_name: string | null;
          store_owner_name: string | null;
          store_owner_email: string | null;
          /** Added for the admin sample-request form and real requests alike —
           *  see supabase/migrations/20260902100000_product_requests_contact_shipping.sql. */
          store_owner_phone: string | null;
          shipping: string | null;
          timeline: string | null;
          note: string | null;
          status: RequestStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          supplier_id: string;
        } & Partial<Omit<Database["public"]["Tables"]["product_requests"]["Row"], "supplier_id">>;
        Update: Partial<Database["public"]["Tables"]["product_requests"]["Row"]>;
        Relationships: [];
      };
      request_items: {
        Row: {
          id: string;
          request_id: string;
          product_id: string | null;
          product_name: string;
          quantity: number;
        };
        Insert: {
          request_id: string;
          product_name: string;
          product_id?: string | null;
          quantity?: number;
        };
        Update: Partial<Database["public"]["Tables"]["request_items"]["Row"]>;
        Relationships: [];
      };
      request_messages: {
        Row: {
          id: string;
          request_id: string;
          sender: MessageSender;
          body: string;
          created_at: string;
        };
        Insert: {
          request_id: string;
          sender: MessageSender;
          body: string;
        };
        Update: Partial<Database["public"]["Tables"]["request_messages"]["Row"]>;
        Relationships: [];
      };
      supplier_members: {
        Row: {
          id: string;
          supplier_id: string;
          user_id: string | null;
          invited_email: string;
          role: UserRole;
          status: "invited" | "active" | "revoked";
          created_at: string;
        };
        Insert: {
          supplier_id: string;
          invited_email: string;
          user_id?: string | null;
          role?: UserRole;
          status?: "invited" | "active" | "revoked";
        };
        Update: Partial<Database["public"]["Tables"]["supplier_members"]["Row"]>;
        Relationships: [];
      };
      subscriptions: {
        Row: {
          user_id: string;
          plan: PlanTier;
          status: SubscriptionStatus;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          current_period_end: string | null;
          trial_ends_at: string | null;
          promo_eligible: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: { user_id: string } & Partial<
          Omit<Database["public"]["Tables"]["subscriptions"]["Row"], "user_id">
        >;
        Update: Partial<Database["public"]["Tables"]["subscriptions"]["Row"]>;
        Relationships: [];
      };
      usage_daily: {
        Row: { user_id: string; day: string; tokens_used: number };
        Insert: { user_id: string; day?: string; tokens_used?: number };
        Update: Partial<Database["public"]["Tables"]["usage_daily"]["Row"]>;
        Relationships: [];
      };
      /** Supplier-side counterpart of `subscriptions` — keyed by `supplier_id`
       *  (the business), not `user_id`, matching `supplier_wallets`' pooled
       *  balance model. See supabase/migrations/20260901170000_supplier_subscriptions.sql. */
      supplier_subscriptions: {
        Row: {
          supplier_id: string;
          plan: PlanTier;
          status: SubscriptionStatus;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          current_period_end: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: { supplier_id: string } & Partial<
          Omit<Database["public"]["Tables"]["supplier_subscriptions"]["Row"], "supplier_id">
        >;
        Update: Partial<Database["public"]["Tables"]["supplier_subscriptions"]["Row"]>;
        Relationships: [];
      };
      supplier_usage_daily: {
        Row: { supplier_id: string; day: string; tokens_used: number };
        Insert: { supplier_id: string; day?: string; tokens_used?: number };
        Update: Partial<Database["public"]["Tables"]["supplier_usage_daily"]["Row"]>;
        Relationships: [];
      };
      shopify_stores: {
        Row: {
          id: string;
          shop_domain: string;
          shopify_shop_id: string | null;
          access_token: string | null;
          scopes: string | null;
          status: ShopifyStoreStatus;
          owner_user_id: string | null;
          assigned_at: string | null;
          transferred_at: string | null;
          theme_id: string | null;
          sync_status: string | null;
          storefront_password: string | null;
          transfer_email: string | null;
          transfer_requested_at: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: { shop_domain: string } & Partial<
          Omit<Database["public"]["Tables"]["shopify_stores"]["Row"], "shop_domain">
        >;
        Update: Partial<Database["public"]["Tables"]["shopify_stores"]["Row"]>;
        Relationships: [];
      };
      stores: {
        Row: {
          id: string;
          user_id: string;
          type: StoreType;
          name: string | null;
          status: StoreStatus;
          domain: string | null;
          /** Set only once DNS was proven to point at us — see storefront-by-domain routing. Null means "not routed," regardless of what `domain` holds. */
          domain_verified_at: string | null;
          /** The Resend Audience id for this store's newsletter signups — lazily created, see newsletter.ts. */
          newsletter_audience_id: string | null;
          subdomain: string | null;
          theme: string | null;
          shopify_store_id: string | null;
          live_url: string | null;
          logo_url: string | null;
          content: Record<string, unknown>;
          /** When Launch was pressed. NULL means it's still a builder draft. */
          launched_at: string | null;
          /** Builder product picks, held until Launch turns them into listings. */
          draft_products: { id: string; price: number | null }[];
          created_at: string;
          updated_at: string;
        };
        Insert: { user_id: string; type: StoreType } & Partial<
          Omit<Database["public"]["Tables"]["stores"]["Row"], "user_id" | "type">
        >;
        Update: Partial<Database["public"]["Tables"]["stores"]["Row"]>;
        Relationships: [];
      };
      orders: {
        Row: {
          id: string;
          number: number;
          supplier_id: string;
          request_id: string | null;
          store_name: string | null;
          /** The end customer's name/email/phone — despite the table's
           *  `store_*` prefix elsewhere, these are who the supplier ships
           *  to, not the merchant. See supabase/migrations/20260901130000_orders_customer_fields.sql. */
          customer_name: string | null;
          customer_email: string | null;
          customer_phone: string | null;
          shipping: string | null;
          status: OrderStatus;
          /** The merchant's store — added for Docs/Credits-Settlement-Plan.md;
           *  nullable because it doesn't backfill pre-existing rows. */
          store_id: string | null;
          /** Back-link to the customer-facing checkout this order was split
           *  out of — see supabase/migrations/20260901140000_orders_store_order_link.sql.
           *  Nullable because it doesn't backfill pre-existing rows. */
          store_order_id: string | null;
          payment_type: OrderPaymentType | null;
          cost_amount: number | null;
          margin_amount: number | null;
          platform_fee_amount: number | null;
          credit_status: OrderCreditStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          supplier_id: string;
        } & Partial<Omit<Database["public"]["Tables"]["orders"]["Row"], "supplier_id" | "number">>;
        Update: Partial<Database["public"]["Tables"]["orders"]["Row"]>;
        Relationships: [];
      };
      order_items: {
        Row: {
          id: string;
          order_id: string;
          product_id: string | null;
          product_name: string;
          quantity: number;
          unit_price: number | null;
        };
        Insert: {
          order_id: string;
          product_name: string;
          product_id?: string | null;
          quantity?: number;
          unit_price?: number | null;
        };
        Update: Partial<Database["public"]["Tables"]["order_items"]["Row"]>;
        Relationships: [];
      };
      selected_products: {
        Row: { user_id: string; product_id: string; created_at: string };
        Insert: { user_id: string; product_id: string };
        Update: Partial<Database["public"]["Tables"]["selected_products"]["Row"]>;
        Relationships: [];
      };
      store_products: {
        Row: {
          store_id: string;
          product_id: string;
          price: number | null;
          supplier_id: string | null;
          status: ListingStatus;
          decided_at: string | null;
          decline_reason: string | null;
          shopify_product_id: string | null;
          shopify_synced_at: string | null;
          /** Merchant-set, per store — varies store to store, unlike the
           *  supplier-owned product content. */
          shipping_note: string | null;
          /** Captured alongside shopify_product_id at sync time; lets a
           *  generated theme link back to the product's live page. */
          shopify_handle: string | null;
          created_at: string;
        };
        Insert: {
          store_id: string;
          product_id: string;
          price?: number | null;
          supplier_id?: string | null;
          status?: ListingStatus;
        };
        Update: Partial<Database["public"]["Tables"]["store_products"]["Row"]>;
        Relationships: [];
      };
      store_theme_versions: {
        Row: {
          id: string;
          store_id: string;
          content: Record<string, unknown>;
          theme: string | null;
          logo_url: string | null;
          label: string | null;
          created_at: string;
        };
        Insert: {
          store_id: string;
          content?: Record<string, unknown>;
          theme?: string | null;
          logo_url?: string | null;
          label?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["store_theme_versions"]["Row"]>;
        Relationships: [];
      };
      store_category_content: {
        Row: {
          id: string;
          store_id: string;
          category: string;
          description: string;
          created_at: string;
        };
        Insert: {
          store_id: string;
          category: string;
          description: string;
        };
        Update: Partial<Database["public"]["Tables"]["store_category_content"]["Row"]>;
        Relationships: [];
      };
      store_posts: {
        Row: {
          id: string;
          store_id: string;
          title: string;
          slug: string;
          excerpt: string | null;
          body: string;
          cover_image: string | null;
          status: PostStatus;
          source: PostSource;
          seo_title: string | null;
          seo_description: string | null;
          published_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          store_id: string;
          title: string;
          slug: string;
          excerpt?: string | null;
          body?: string;
          cover_image?: string | null;
          status?: PostStatus;
          source?: PostSource;
          seo_title?: string | null;
          seo_description?: string | null;
          published_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["store_posts"]["Row"]>;
        Relationships: [];
      };
      store_pages: {
        Row: {
          id: string;
          store_id: string;
          title: string;
          slug: string;
          body: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          store_id: string;
          title: string;
          slug: string;
          body?: string;
        };
        Update: Partial<Database["public"]["Tables"]["store_pages"]["Row"]>;
        Relationships: [];
      };
      customers: {
        Row: {
          id: string;
          store_id: string;
          email: string | null;
          name: string | null;
          first_order_at: string;
          last_order_at: string;
          order_count: number;
          lifetime_value: number;
          is_synthetic: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          store_id: string;
          email?: string | null;
          name?: string | null;
          first_order_at?: string;
          last_order_at?: string;
          order_count?: number;
          lifetime_value?: number;
          is_synthetic?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["customers"]["Row"]>;
        Relationships: [];
      };
      store_traffic_events: {
        Row: {
          id: string;
          store_id: string;
          order_id: string | null;
          source: "organic_search" | "paid_search" | "social" | "direct" | "referral" | "email";
          is_synthetic: boolean;
          created_at: string;
        };
        Insert: {
          store_id: string;
          order_id?: string | null;
          source: "organic_search" | "paid_search" | "social" | "direct" | "referral" | "email";
          is_synthetic?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["store_traffic_events"]["Row"]>;
        Relationships: [];
      };
      store_assets: {
        Row: {
          id: string;
          store_id: string;
          user_id: string;
          kind: "image" | "video";
          provider: "supabase" | "r2";
          url: string;
          external_id: string | null;
          file_name: string | null;
          mime_type: string | null;
          bytes: number | null;
          width: number | null;
          height: number | null;
          role: string | null;
          alt: string | null;
          created_at: string;
        };
        Insert: {
          store_id: string;
          user_id: string;
          url: string;
        } & Partial<Omit<Database["public"]["Tables"]["store_assets"]["Row"], "id" | "store_id" | "user_id" | "url" | "created_at">>;
        Update: Partial<Database["public"]["Tables"]["store_assets"]["Row"]>;
        Relationships: [];
      };
      store_orders: {
        Row: {
          id: string;
          store_id: string;
          customer_name: string | null;
          customer_email: string | null;
          shipping: string | null;
          subtotal: number | null;
          items: { product_id: string | null; supplier_id: string | null; name: string; quantity: number; unit_price: number | null }[];
          status: string;
          stripe_session_id: string | null;
          created_at: string;
        };
        Insert: {
          store_id: string;
        } & Partial<Omit<Database["public"]["Tables"]["store_orders"]["Row"], "id" | "store_id" | "created_at">>;
        Update: Partial<Database["public"]["Tables"]["store_orders"]["Row"]>;
        Relationships: [];
      };
      ai_embeddings: {
        Row: {
          id: string;
          /** Defaults to the GLOBAL_TENANT_ID sentinel for shared content (see `@ecomstrait/ai`). */
          tenant_id: string;
          source_type: string;
          source_id: string;
          content: string;
          embedding: number[];
          provider: string;
          created_at: string;
        };
        Insert: {
          source_type: string;
          source_id: string;
          content: string;
          embedding: number[];
          provider: string;
        } & Partial<Pick<Database["public"]["Tables"]["ai_embeddings"]["Row"], "tenant_id">>;
        Update: Partial<Database["public"]["Tables"]["ai_embeddings"]["Row"]>;
        Relationships: [];
      };
      ai_agent_runs: {
        Row: {
          id: string;
          tenant_id: string;
          agent: string;
          thread_id: string;
          status: string;
          input: Record<string, unknown>;
          output: Record<string, unknown> | null;
          tool_calls: unknown[];
          created_at: string;
          updated_at: string;
        };
        Insert: {
          tenant_id: string;
          agent: string;
          thread_id: string;
          input: Record<string, unknown>;
        } & Partial<
          Omit<
            Database["public"]["Tables"]["ai_agent_runs"]["Row"],
            "id" | "tenant_id" | "agent" | "thread_id" | "input" | "created_at" | "updated_at"
          >
        >;
        Update: Partial<Database["public"]["Tables"]["ai_agent_runs"]["Row"]>;
        Relationships: [];
      };
      ai_approvals: {
        Row: {
          id: string;
          /** Optional backreference — see 20260829150000_ai_approvals_context.sql. */
          agent_run_id: string | null;
          tenant_id: string | null;
          thread_id: string | null;
          action: string;
          payload: Record<string, unknown>;
          status: string;
          approved_by: string | null;
          created_at: string;
          resolved_at: string | null;
        };
        Insert: {
          action: string;
          payload: Record<string, unknown>;
        } & Partial<
          Omit<Database["public"]["Tables"]["ai_approvals"]["Row"], "id" | "action" | "payload" | "created_at">
        >;
        Update: Partial<Database["public"]["Tables"]["ai_approvals"]["Row"]>;
        Relationships: [];
      };
      ai_cost_ledger: {
        Row: {
          id: string;
          tenant_id: string;
          role: string;
          model: string;
          input_tokens: number;
          output_tokens: number;
          cost_usd: number;
          created_at: string;
        };
        Insert: {
          tenant_id: string;
          role: string;
          model: string;
          input_tokens: number;
          output_tokens: number;
          cost_usd: number;
        };
        Update: Partial<Database["public"]["Tables"]["ai_cost_ledger"]["Row"]>;
        Relationships: [];
      };
      ai_snapshot_cache: {
        Row: {
          id: string;
          subject_type: "merchant" | "supplier";
          subject_id: string;
          snapshot_json: Record<string, unknown>;
          computed_at: string;
        };
        Insert: {
          subject_type: "merchant" | "supplier";
          subject_id: string;
          snapshot_json: Record<string, unknown>;
          computed_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["ai_snapshot_cache"]["Row"]>;
        Relationships: [];
      };
      ai_chat_threads: {
        Row: {
          id: string;
          tenant_id: string;
          agent: "merchant_cofounder" | "supplier_cofounder" | "merchant_builder";
          thread_key: string;
          messages: { role: "user" | "assistant"; content: string; at?: string }[];
          summary: string | null;
          updated_at: string;
        };
        Insert: {
          tenant_id: string;
          agent: "merchant_cofounder" | "supplier_cofounder" | "merchant_builder";
          thread_key: string;
          messages?: { role: "user" | "assistant"; content: string; at?: string }[];
          summary?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["ai_chat_threads"]["Row"]>;
        Relationships: [];
      };
      merchant_wallets: {
        Row: { user_id: string; balance: number; updated_at: string };
        Insert: { user_id: string; balance?: number };
        Update: Partial<Database["public"]["Tables"]["merchant_wallets"]["Row"]>;
        Relationships: [];
      };
      supplier_wallets: {
        Row: { supplier_id: string; balance: number; updated_at: string };
        Insert: { supplier_id: string; balance?: number };
        Update: Partial<Database["public"]["Tables"]["supplier_wallets"]["Row"]>;
        Relationships: [];
      };
      wallet_transactions: {
        Row: {
          id: string;
          account_type: WalletAccountType;
          account_id: string;
          kind: WalletTransactionKind;
          amount: number;
          balance_after: number;
          order_id: string | null;
          note: string | null;
          /** Idempotency key for the real-world event this row represents
           *  (e.g. a Stripe checkout session id) — unique when set, enforced
           *  by a partial unique index, not by app-level convention. */
          external_ref: string | null;
          created_at: string;
        };
        Insert: {
          account_type: WalletAccountType;
          account_id: string;
          kind: WalletTransactionKind;
          amount: number;
          balance_after: number;
          order_id?: string | null;
          note?: string | null;
          external_ref?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["wallet_transactions"]["Row"]>;
        Relationships: [];
      };
      payable_ledger: {
        Row: {
          id: string;
          account_type: WalletAccountType;
          account_id: string;
          order_id: string;
          amount: number;
          status: PayableStatus;
          settlement_batch_id: string | null;
          /** Admin-set: excluded from `runWeeklySettlement` while true, independent of any payout_requests row. */
          held: boolean;
          /** Set while this row is earmarked for a specific (usually still-pending) withdrawal request — see payout_requests. */
          payout_request_id: string | null;
          created_at: string;
        };
        Insert: {
          account_type: WalletAccountType;
          account_id: string;
          order_id: string;
          amount: number;
          status?: PayableStatus;
          settlement_batch_id?: string | null;
          held?: boolean;
          payout_request_id?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["payable_ledger"]["Row"]>;
        Relationships: [];
      };
      payout_requests: {
        Row: {
          id: string;
          account_type: WalletAccountType;
          account_id: string;
          amount: number;
          bank_account_name: string;
          bank_name: string;
          bank_account_number: string;
          bank_routing_code: string | null;
          note: string | null;
          status: PayoutRequestStatus;
          /** Path within the `payout-receipts` bucket, not a full URL — read via a signed URL generated on demand. */
          receipt_path: string | null;
          admin_note: string | null;
          requested_at: string;
          reviewed_at: string | null;
          reviewed_by: string | null;
        };
        Insert: {
          account_type: WalletAccountType;
          account_id: string;
          amount: number;
          bank_account_name: string;
          bank_name: string;
          bank_account_number: string;
          bank_routing_code?: string | null;
          note?: string | null;
          status?: PayoutRequestStatus;
          receipt_path?: string | null;
          admin_note?: string | null;
          requested_at?: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["payout_requests"]["Row"]>;
        Relationships: [];
      };
      settlement_batches: {
        Row: {
          id: string;
          period_start: string;
          period_end: string;
          run_at: string;
          status: SettlementBatchStatus;
          total_to_merchants: number;
          total_to_suppliers: number;
          paid_at: string | null;
          paid_by: string | null;
        };
        Insert: {
          period_start: string;
          period_end: string;
          run_at?: string;
          status?: SettlementBatchStatus;
          total_to_merchants?: number;
          total_to_suppliers?: number;
          paid_at?: string | null;
          paid_by?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["settlement_batches"]["Row"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      wallet_adjust: {
        Args: {
          p_account_type: WalletAccountType;
          p_account_id: string;
          p_amount: number;
          p_kind: WalletTransactionKind;
          p_order_id?: string | null;
          p_note?: string | null;
          /** Idempotency key (e.g. a Stripe checkout session id) — a second
           *  call with the same value is a guaranteed no-op, enforced by a
           *  unique index, not just convention. */
          p_external_ref?: string | null;
        };
        Returns: number | null;
      };
      is_admin: { Args: Record<string, never>; Returns: boolean };
      reverse_cod_deduction: { Args: { p_order_id: string }; Returns: boolean };
      /** service_role only — see the migration. Callable via the admin client. */
      auth_email_exists: { Args: { p_email: string }; Returns: boolean };
    };
    Enums: { user_role: UserRole };
    CompositeTypes: Record<string, never>;
  };
};

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type Supplier = Database["public"]["Tables"]["suppliers"]["Row"];
export type SupplierVerification =
  Database["public"]["Tables"]["supplier_verification"]["Row"];
export type SupplierDocument =
  Database["public"]["Tables"]["supplier_documents"]["Row"];
export type Product = Database["public"]["Tables"]["products"]["Row"];
export type InventoryAdjustment =
  Database["public"]["Tables"]["inventory_adjustments"]["Row"];
export type ProductRequest = Database["public"]["Tables"]["product_requests"]["Row"];
export type RequestItem = Database["public"]["Tables"]["request_items"]["Row"];
export type RequestMessage = Database["public"]["Tables"]["request_messages"]["Row"];
export type SupplierMember = Database["public"]["Tables"]["supplier_members"]["Row"];
export type Order = Database["public"]["Tables"]["orders"]["Row"];
export type OrderItem = Database["public"]["Tables"]["order_items"]["Row"];
export type Subscription = Database["public"]["Tables"]["subscriptions"]["Row"];
export type UsageDaily = Database["public"]["Tables"]["usage_daily"]["Row"];
export type SupplierSubscription = Database["public"]["Tables"]["supplier_subscriptions"]["Row"];
export type SupplierUsageDaily = Database["public"]["Tables"]["supplier_usage_daily"]["Row"];
export type ShopifyStore = Database["public"]["Tables"]["shopify_stores"]["Row"];
export type Store = Database["public"]["Tables"]["stores"]["Row"];
export type AiEmbedding = Database["public"]["Tables"]["ai_embeddings"]["Row"];
export type AiAgentRun = Database["public"]["Tables"]["ai_agent_runs"]["Row"];
export type AiApproval = Database["public"]["Tables"]["ai_approvals"]["Row"];
export type AiCostLedgerEntry = Database["public"]["Tables"]["ai_cost_ledger"]["Row"];
export type AiChatThread = Database["public"]["Tables"]["ai_chat_threads"]["Row"];
export type MerchantWallet = Database["public"]["Tables"]["merchant_wallets"]["Row"];
export type SupplierWallet = Database["public"]["Tables"]["supplier_wallets"]["Row"];
export type WalletTransaction = Database["public"]["Tables"]["wallet_transactions"]["Row"];
export type PayableLedgerEntry = Database["public"]["Tables"]["payable_ledger"]["Row"];
export type SettlementBatch = Database["public"]["Tables"]["settlement_batches"]["Row"];
export type PayoutRequest = Database["public"]["Tables"]["payout_requests"]["Row"];
