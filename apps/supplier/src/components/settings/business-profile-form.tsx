"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Loader2, Pencil, X } from "lucide-react";
import type { SupplierStatus } from "@ecomstrait/db/types";
import { Button } from "@/components/ui";
import { FieldInput } from "@/components/onboarding/fields";
import { STEP1_FIELDS, STEP2_FIELDS, STEP4_FIELDS, type FieldDef, type SupplierForm } from "@/lib/onboarding";
import { saveSupplier } from "@/lib/supplier-actions";
import { useToast } from "@/components/app/toast";

const GROUPS: { title: string; fields: FieldDef[] }[] = [
  { title: "Business information", fields: STEP1_FIELDS },
  { title: "Business details", fields: STEP2_FIELDS },
  { title: "Product information", fields: STEP4_FIELDS },
];

/**
 * Read-only view of the business profile with an inline edit mode. Reuses
 * the onboarding wizard's field definitions and `saveSupplier`, so what a
 * supplier can change here is exactly what they entered during onboarding —
 * status, verification and quality score stay admin-controlled.
 */
export function BusinessProfileForm({
  initialForm,
  status,
  canEdit,
  documents,
}: {
  initialForm: SupplierForm;
  status: SupplierStatus;
  canEdit: boolean;
  documents: { label: string; uploaded: boolean }[];
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<SupplierForm>(initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof SupplierForm>(k: K, v: SupplierForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function cancel() {
    setForm(initialForm);
    setError(null);
    setEditing(false);
  }

  async function save() {
    const missing = GROUPS.flatMap((g) => g.fields).some((def) => {
      if (!def.required) return false;
      const v = form[def.name];
      return Array.isArray(v) ? v.length === 0 : !String(v).trim();
    });
    if (missing) {
      setError("Please fill in all required fields.");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await saveSupplier(form);
    setSaving(false);
    if ("error" in res) {
      setError(res.error);
      return;
    }
    setEditing(false);
    showToast("Business profile updated.");
    router.refresh();
  }

  const display = (def: FieldDef): string => {
    const v = form[def.name];
    return Array.isArray(v) ? v.join(", ") : v;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink-500">Status</span>
          <span className="rounded-full bg-ink-100 px-2.5 py-1 text-xs font-semibold capitalize text-ink-600">
            {status.replace("_", " ")}
          </span>
          {status === "pending" && canEdit && (
            <Link href="/onboarding" className="text-sm font-semibold text-brand-600 hover:underline">
              Continue onboarding
            </Link>
          )}
        </div>
        {canEdit && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3.5 text-sm font-semibold text-ink-800 hover:bg-ink-50"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
        )}
      </div>

      {GROUPS.map((group) => (
        <section key={group.title} className="rounded-2xl border border-ink-100 bg-white p-5">
          <h2 className="text-sm font-semibold text-ink-950">{group.title}</h2>
          {editing ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {group.fields.map((def) => (
                <FieldInput key={def.name} def={def} form={form} set={set} />
              ))}
            </div>
          ) : (
            <dl className="mt-2">
              {group.fields.map((def) => (
                <div
                  key={def.name}
                  className="flex flex-col gap-0.5 border-b border-ink-50 py-3 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                >
                  <dt className="text-sm text-ink-500">{def.label.replace(" (optional)", "")}</dt>
                  <dd className="whitespace-pre-line text-sm font-medium text-ink-900 sm:max-w-[60%] sm:text-right">
                    {display(def) || "—"}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ))}

      <section className="rounded-2xl border border-ink-100 bg-white p-5">
        <h2 className="text-sm font-semibold text-ink-950">Verification documents</h2>
        <ul className="mt-2">
          {documents.map((d) => (
            <li
              key={d.label}
              className="flex items-center justify-between gap-4 border-b border-ink-50 py-3 last:border-0"
            >
              <span className="text-sm text-ink-500">{d.label}</span>
              <span className={`text-sm font-medium ${d.uploaded ? "text-brand-600" : "text-ink-400"}`}>
                {d.uploaded ? "Uploaded" : "Not uploaded"}
              </span>
            </li>
          ))}
        </ul>
        {status === "pending" && canEdit && (
          <p className="mt-3 text-xs text-ink-400">
            Documents are uploaded from the onboarding wizard (step 3).
          </p>
        )}
      </section>

      {editing && (
        <div className="flex flex-col gap-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={cancel} disabled={saving} className="w-auto">
              <X className="h-4 w-4" /> Cancel
            </Button>
            <Button type="button" onClick={save} disabled={saving} className="w-auto">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Save changes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
