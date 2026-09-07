"use client";

import { useState } from "react";
import { Check, Loader2, Upload } from "lucide-react";
import { createClient } from "@ecomstrait/auth/client";
import { cn } from "@ecomstrait/ui";
import type { DocumentType } from "@ecomstrait/db/types";
import { DOCUMENTS } from "@/lib/onboarding";
import { recordDocument } from "@/lib/supplier-actions";

export function DocumentsStep({
  userId,
  supplierId,
  ensureSupplierId,
  uploaded,
  onUploaded,
}: {
  userId: string;
  supplierId: string | null;
  /** Creates the suppliers row if the wizard hasn't saved one yet (Continue
   *  no longer writes to the database) — a document needs a row to attach to. */
  ensureSupplierId: () => Promise<string | null>;
  uploaded: Record<string, string>;
  onUploaded: (type: DocumentType, path: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(type: DocumentType, file: File) {
    setBusy(type);
    setError(null);
    try {
      const id = supplierId ?? (await ensureSupplierId());
      if (!id) {
        setError("Please complete the earlier steps first.");
        return;
      }
      const supabase = createClient();
      const ext = file.name.split(".").pop() || "bin";
      // One document per type — a stable path + upsert overwrites on re-upload.
      const path = `${userId}/${type}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("supplier-documents")
        .upload(path, file, { upsert: true });
      if (upErr) throw upErr;

      const res = await recordDocument({ supplierId: id, type, storagePath: path });
      if ("error" in res) throw new Error(res.error);
      onUploaded(type, path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-500">
        Upload clear photos or PDFs. Files are stored privately and used only for verification.
      </p>
      {DOCUMENTS.map((doc) => {
        const done = Boolean(uploaded[doc.type]);
        const loading = busy === doc.type;
        return (
          <label
            key={doc.type}
            className={cn(
              "flex cursor-pointer items-center justify-between gap-4 rounded-xl border px-4 py-3 transition",
              done ? "border-brand-200 bg-brand-50/60" : "border-ink-200 bg-white hover:border-ink-300",
            )}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink-900">
                {doc.label}
                {doc.required && <span className="ml-1 text-red-500">*</span>}
              </p>
              {done && <p className="text-xs text-brand-600">Uploaded</p>}
            </div>
            <span
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold",
                done ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-700",
              )}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : done ? (
                <>
                  <Check className="h-4 w-4" /> Replace
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" /> Upload
                </>
              )}
            </span>
            <input
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              disabled={loading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(doc.type, f);
                e.target.value = "";
              }}
            />
          </label>
        );
      })}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
