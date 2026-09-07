import { requireUser, getProfile } from "@ecomstrait/auth/session";
import { ensureSubscription } from "@/lib/subscription";
import { ensureMerchantRole } from "@/lib/merchant-role";
import { MerchantChrome } from "@/components/app/merchant-chrome";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Every merchant gets a subscription row (Free, or the first-100 Full promo),
  // and the role that lets them create stores.
  await Promise.all([ensureSubscription(), ensureMerchantRole(user.id)]);
  const profile = await getProfile();
  return (
    <MerchantChrome email={user.email ?? ""} fullName={profile?.full_name} avatarUrl={profile?.avatar_url}>
      {children}
    </MerchantChrome>
  );
}
