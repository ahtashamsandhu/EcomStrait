"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/app/toast";

/**
 * The onboarding wizard lives outside AppChrome (no ToastProvider there), so
 * "Save & exit" and "Submit for review" both land on the dashboard with a
 * flag in the URL and the toast is shown here instead. The flag is stripped
 * straight after so a refresh or a shared link doesn't replay it.
 */
export function OnboardingToast() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { showToast } = useToast();

  const onboarded = params.get("onboarded") === "1";
  const saved = params.get("saved") === "1";

  useEffect(() => {
    if (!onboarded && !saved) return;
    showToast(
      onboarded
        ? "Application submitted — we'll email you once it's reviewed."
        : "Progress saved. Pick up where you left off any time.",
    );
    router.replace(pathname, { scroll: false });
  }, [onboarded, saved, showToast, router, pathname]);

  return null;
}
