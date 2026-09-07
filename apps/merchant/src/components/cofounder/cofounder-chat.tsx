"use client";

import { useRef, useState, useEffect } from "react";
import { Send, Loader2, Sparkles, Copy, Check, Square } from "lucide-react";
import { askCoFounderAction } from "@/lib/cofounder-actions";
import type { CoFounderTurn } from "@/lib/cofounder-ai";
import { ChatMarkdown } from "@/components/cofounder/chat-markdown";
import { UpgradeModal } from "@/components/billing/upgrade-modal";

type Message = CoFounderTurn;

export function CoFounderChat({
  businessName,
  initialMessages = [],
  initialTokensRemaining,
}: {
  businessName: string | null;
  /** Today's remaining AI budget at page load; every reply carries the new
   *  figure back and the counter below updates without a reload. */
  initialTokensRemaining: number;
  /** The persisted thread's last (up to) 30 messages — see
   *  `Docs/prompts/merchant-cofounder-chat.md` — so reopening this chat
   *  continues the conversation instead of starting cold. */
  initialMessages?: Message[];
}) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [tokensRemaining, setTokensRemaining] = useState(initialTokensRemaining);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [upgradeMsg, setUpgradeMsg] = useState<string | null>(null);
  // Not `useTransition`: `isPending` only clears once the awaited action
  // itself resolves, and Server Actions expose no cancellation — there's no
  // way to actually abort one already in flight. This is what makes Stop
  // possible at all — it can be flipped off the instant the button is
  // clicked, independent of whether the request is still running.
  const [busy, setBusy] = useState(false);
  // Guards against a reply that keeps generating after Stop was clicked —
  // when (if) it eventually arrives, it's silently dropped instead of
  // popping into the chat after the visitor already moved on. Reset at the
  // start of every new send, not just on stop.
  const cancelledRef = useRef(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    setInput("");
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    cancelledRef.current = false;
    setBusy(true);
    const res = await askCoFounderAction(messages, text);
    if (cancelledRef.current) return; // Stopped — the visitor already moved on.
    setBusy(false);
    if ("error" in res) {
      if (res.upgrade) setUpgradeMsg(res.error);
      else setError(res.error);
      return;
    }
    setTokensRemaining(res.tokensRemaining);
    setMessages((m) => [...m, { role: "assistant", content: res.reply }]);
  }

  /** Give up on the in-flight reply — for a prompt sent by mistake, no
   *  point waiting out (or later being confused by) an answer to it. */
  function stop() {
    cancelledRef.current = true;
    setBusy(false);
  }

  function copyMessage(id: number, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1200);
    });
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-ink-100 bg-white">
      <div className="flex items-center justify-end border-b border-ink-50 px-4 py-2">
        <span className="text-xs font-medium text-ink-400" aria-live="polite">
          {tokensRemaining.toLocaleString()} AI tokens left today
        </span>
      </div>
      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto p-5">
        {messages.length === 0 && (
          <div className="grid h-full place-items-center text-center">
            <div>
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-brand-600">
                <Sparkles className="h-6 w-6" />
              </span>
              <p className="mt-3 text-sm font-medium text-ink-700">
                Hi{businessName ? `, ${businessName}` : ""} — I&apos;m your AI co-founder.
              </p>
              <p className="mt-1 max-w-sm text-sm text-ink-400">
                Ask me about your revenue trend, which store is winning, orders stuck on low
                credits, or how to grow — I only work from your real numbers.
              </p>
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col gap-1 ${m.role === "user" ? "items-end" : "items-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                m.role === "user" ? "whitespace-pre-wrap bg-brand-500 text-white" : "bg-ink-50 text-ink-800"
              }`}
            >
              {m.role === "assistant" ? <ChatMarkdown text={m.content} /> : m.content}
            </div>
            <button
              type="button"
              onClick={() => copyMessage(i, m.content)}
              aria-label="Copy message"
              className="inline-flex items-center gap-1 px-1 text-[11px] font-medium text-ink-400 transition hover:text-ink-700"
            >
              {copiedId === i ? (
                <>
                  <Check className="h-3 w-3 text-brand-600" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" /> Copy
                </>
              )}
            </button>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl bg-ink-50 px-4 py-2.5 text-sm text-ink-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          </div>
        )}
      </div>

      {error && <p className="border-t border-ink-50 px-5 py-2 text-sm text-red-600">{error}</p>}

      <form onSubmit={send} className="flex items-center gap-2 border-t border-ink-100 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask your co-founder anything about the business…"
          disabled={busy}
          className="flex-1 rounded-xl border border-ink-200 px-3.5 py-2.5 text-sm outline-none focus:border-brand-400 disabled:opacity-60"
        />
        {busy ? (
          <button
            type="button"
            onClick={stop}
            aria-label="Stop"
            title="Stop — sent the wrong thing?"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-red-200 bg-red-50 text-red-600 hover:bg-red-100"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </form>
      {upgradeMsg && <UpgradeModal message={upgradeMsg} onClose={() => setUpgradeMsg(null)} />}
    </div>
  );
}
