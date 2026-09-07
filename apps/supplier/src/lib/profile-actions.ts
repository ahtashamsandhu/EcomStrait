"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@ecomstrait/auth/server";

/**
 * Updates the caller's own `profiles` row. Only the fields actually passed
 * are touched, so an avatar upload and a name edit can each call this
 * independently without clobbering the other.
 *
 * Also mirrors a changed name into auth `user_metadata` — the dashboard
 * greeting and other pages still read `user.user_metadata.full_name` rather
 * than `profiles.full_name`, so both have to move together or they'd drift.
 */
export async function updateProfile(input: {
  fullName?: string;
  avatarUrl?: string | null;
}): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const fullName = input.fullName !== undefined ? input.fullName.trim() : undefined;
  if (fullName !== undefined && !fullName) return { error: "Name can't be empty." };

  const patch: { full_name?: string; avatar_url?: string | null } = {};
  if (fullName !== undefined) patch.full_name = fullName;
  if (input.avatarUrl !== undefined) patch.avatar_url = input.avatarUrl;
  if (Object.keys(patch).length === 0) return {};

  const { error } = await supabase.from("profiles").update(patch).eq("user_id", user.id);
  if (error) return { error: error.message };

  if (fullName !== undefined) {
    await supabase.auth.updateUser({ data: { full_name: fullName } });
  }

  revalidatePath("/settings", "layout");
  return {};
}
