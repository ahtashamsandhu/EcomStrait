"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, HandCoins, X, Landmark } from "lucide-react";
import { requestPayout } from "@/lib/wallet-actions";

const inputClass =
  "h-10 w-full rounded-xl border border-ink-200 px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20";
const labelClass = "grid gap-1.5 text-xs font-semibold text-ink-700";

/**
 * "Withdraw" — a merchant picks an amount (capped at the pending payout
 * balance) and gives a bank account; an admin processes it manually by bank
 * transfer and uploads a receipt once done (see /admin/settlements). This
 * doesn't move money itself.
 *
 * The trigger is a small button inside the balance card; the form itself opens
 * in a centered dialog so the card keeps its shape.
 */
export function WithdrawalForm({ pendingPayout }: { pendingPayout: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState(String(pendingPayout.toFixed(2)));
  const [bankAccountName, setBankAccountName] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankRoutingCode, setBankRoutingCode] = useState("");
  const [note, setNote] = useState("");

  function close() {
    if (pending) return;
    setOpen(false);
    setError(null);
  }

  // Escape closes the dialog, like the other modals in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await requestPayout({
        amount: Number(amount),
        bankAccountName,
        bankName,
        bankAccountNumber,
        bankRoutingCode: bankRoutingCode || undefined,
        note: note || undefined,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        disabled={pendingPayout <= 0}
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
      >
        <HandCoins className="h-3.5 w-3.5" /> Withdraw
      </button>

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <div className="absolute inset-0 bg-ink-950/40" onClick={close} />
          <form
            onSubmit={submit}
            role="dialog"
            aria-modal="true"
            aria-labelledby="withdraw-title"
            className="relative w-full max-w-md rounded-2xl border border-ink-100 bg-white p-5 shadow-xl sm:p-6"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600">
                  <HandCoins className="h-5 w-5" />
                </span>
                <div>
                  <p id="withdraw-title" className="text-base font-bold text-ink-950">
                    Withdraw funds
                  </p>
                  <p className="text-xs text-ink-500">
                    Up to <span className="font-semibold text-ink-800">${pendingPayout.toFixed(2)}</span>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-ink-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 grid gap-4">
              <label className={labelClass}>
                Amount (USD)
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-sm text-ink-400">
                    $
                  </span>
                  <input
                    type="number"
                    min={0.01}
                    max={pendingPayout}
                    step="0.01"
                    required
                    autoFocus
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className={`${inputClass} pl-7 pr-16 font-semibold text-ink-900`}
                  />
                  <button
                    type="button"
                    onClick={() => setAmount(pendingPayout.toFixed(2))}
                    className="absolute inset-y-0 right-2 my-auto h-7 rounded-lg px-2 text-[11px] font-semibold text-brand-700 hover:bg-brand-50"
                  >
                    Max
                  </button>
                </div>
              </label>

              <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-ink-800">
                  <Landmark className="h-4 w-4 text-ink-400" /> Bank account
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className={labelClass}>
                    Account holder name
                    <input
                      required
                      autoComplete="name"
                      value={bankAccountName}
                      onChange={(e) => setBankAccountName(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className={labelClass}>
                    Bank name
                    <input required value={bankName} onChange={(e) => setBankName(e.target.value)} className={inputClass} />
                  </label>
                  <label className={labelClass}>
                    Account number
                    <input
                      required
                      inputMode="numeric"
                      value={bankAccountNumber}
                      onChange={(e) => setBankAccountNumber(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className={labelClass}>
                    Routing / IFSC / SWIFT
                    <input
                      placeholder="Optional"
                      value={bankRoutingCode}
                      onChange={(e) => setBankRoutingCode(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                </div>
              </div>

              <label className={labelClass}>
                Note
                <input
                  placeholder="Optional — anything the admin should know"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className={inputClass}
                />
              </label>
            </div>

            <p className="mt-4 text-xs text-ink-500">
              An admin will process this by bank transfer and upload a receipt once it&apos;s done.
            </p>

            {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={pending}
                className="inline-flex h-10 items-center rounded-xl border border-ink-200 px-4 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white shadow-lg shadow-brand-500/25 transition hover:bg-brand-700 disabled:opacity-60"
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />}
                Submit request
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
