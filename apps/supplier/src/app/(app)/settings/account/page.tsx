import type { Metadata } from "next";
import type { SupplierMember } from "@ecomstrait/db/types";
import { getProfile } from "@ecomstrait/auth/session";
import { createClient } from "@ecomstrait/auth/server";
import { getMySupplier } from "@/lib/supplier-context";
import { TeamManager } from "@/components/settings/team-manager";
import { ProfileCard } from "@/components/settings/profile-card";
import { PasswordCard } from "@/components/settings/password-card";

export const metadata: Metadata = { title: "Account settings" };

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-ink-50 py-3 last:border-0">
      <dt className="text-sm text-ink-500">{label}</dt>
      <dd className="text-sm font-medium text-ink-900">{value || "—"}</dd>
    </div>
  );
}

export default async function AccountSettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const profile = await getProfile();
  const my = await getMySupplier();

  const { data: members } =
    my?.isOwner
      ? await supabase
          .from("supplier_members")
          .select("*")
          .eq("supplier_id", my.supplierId)
          .order("created_at", { ascending: true })
      : { data: [] };

  return (
    <div>
      <ProfileCard
        userId={user?.id ?? ""}
        email={user?.email ?? ""}
        initialFullName={profile?.full_name ?? (user?.user_metadata?.full_name as string) ?? ""}
        initialAvatarUrl={profile?.avatar_url ?? null}
      />

      <section className="mt-4 rounded-2xl border border-ink-100 bg-white p-5">
        <h2 className="text-sm font-semibold text-ink-950">Account</h2>
        <dl className="mt-2">
          <Row label="Email" value={user?.email ?? ""} />
          <Row label="Role" value={(profile?.role ?? "supplier").replace("_", " ")} />
          {my && !my.isOwner && <Row label="Access" value="Staff member" />}
        </dl>
      </section>

      <div className="mt-4">
        <PasswordCard
          email={user?.email ?? ""}
          hasPassword={(user?.identities ?? []).some((i) => i.provider === "email")}
        />
      </div>

      {/* Team — owner only */}
      {my?.isOwner && (
        <section className="mt-4 rounded-2xl border border-ink-100 bg-white p-5">
          <h2 className="text-sm font-semibold text-ink-950">Team</h2>
          <p className="mb-4 mt-1 text-xs text-ink-400">
            Invite staff to help manage your catalog, inventory, and requests. They&apos;ll be added
            automatically when they sign in with the invited email.
          </p>
          <TeamManager members={(members ?? []) as SupplierMember[]} />
        </section>
      )}
    </div>
  );
}
