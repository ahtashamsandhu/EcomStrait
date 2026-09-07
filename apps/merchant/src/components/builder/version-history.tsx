"use client";

import { useState } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { useClickOutside } from "@ecomstrait/ui";
import { listStoreVersions, restoreStoreVersion, type StoreVersion } from "@/lib/builder-actions";

/**
 * Undo control for a launched store. Versions load on open rather than with the
 * page, so the workbench isn't slowed down for merchants who never use it.
 */
export function VersionHistory({
  storeId,
  onRestored,
}: {
  storeId: string;
  onRestored: (note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<StoreVersion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const menuRef = useClickOutside<HTMLDivElement>(open, () => setOpen(false));

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && versions === null) {
      setBusy("load");
      setVersions(await listStoreVersions(storeId));
      setBusy(null);
    }
  }

  async function restore(id: string) {
    setBusy(id);
    const res = await restoreStoreVersion(storeId, id);
    setBusy(null);
    setOpen(false);
    setVersions(null); // refetch next open — the restore added a snapshot
    onRestored(res.error ? `⚠️ ${res.error}` : (res.note ?? "Restored."));
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink-200 px-3 text-sm font-semibold text-ink-700 hover:bg-ink-50"
      >
        <History className="h-3.5 w-3.5" /> History
      </button>

      {open && (
        <div className="absolute bottom-11 right-0 z-30 w-72 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-lg">
          <p className="border-b border-ink-100 px-3 py-2 text-xs font-semibold text-ink-500">
            Recent changes
          </p>
          {busy === "load" ? (
            <p className="px-3 py-4 text-center text-xs text-ink-400">
              <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading…
            </p>
          ) : !versions?.length ? (
            <p className="px-3 py-4 text-center text-xs text-ink-400">
              No earlier versions yet. Your next change is saved here.
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center gap-2 border-b border-ink-50 px-3 py-2 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-ink-800">
                      {v.label || "Earlier version"}
                    </p>
                    <p className="text-[11px] text-ink-400">
                      {new Date(v.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => restore(v.id)}
                    disabled={Boolean(busy)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-50"
                  >
                    {busy === v.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
