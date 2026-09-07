import { redirect } from "next/navigation";

/** Settings is split into tabs — Account is the default one. */
export default function SettingsPage() {
  redirect("/settings/account");
}
