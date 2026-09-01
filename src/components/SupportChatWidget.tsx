"use client";

import { useEffect, useRef, useState } from "react";
import { useSupportChat } from "./SupportChatContext";

interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  isMe: boolean;
  authorName: string;
  isSupport: boolean;
}

// Floating popup instead of a dedicated full-screen page — reported: a
// full-screen chat replaced whatever the user was actually trying to
// describe (an error on an invoice, most often), so there was nothing left
// on screen to point at. This overlays the corner instead, leaving the
// rest of the page visible underneath. Polls its own JSON endpoint
// (/api/support/messages) rather than router.refresh(), so it doesn't
// also re-fetch the (often heavy) page it's floating on top of.
// Authored by Araza.
export function SupportChatWidget() {
  const { open, setOpen } = useSupportChat();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchMessages = async () => {
    try {
      const res = await fetch("/api/support/messages", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { messages: ChatMessage[] };
      setMessages(json.messages);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    if (!open) return;
    fetchMessages();
    const timer = setInterval(fetchMessages, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/support/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        // Restore the draft rather than silently losing it — previously
        // the input cleared unconditionally before the request even
        // resolved, so a failed send (auth hiccup, no organization found,
        // a DB error) looked identical to a successful one: the box went
        // empty and nothing ever appeared, with no record and no error.
        const json = await res.json().catch(() => null);
        setSendError(json?.error ?? "Could not send. Try again.");
        return;
      }
      setText("");
      await fetchMessages();
    } catch {
      setSendError("Could not send. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* Trigger bubble — always visible, independent of the sidebar link,
          so support is reachable even with the sidebar collapsed. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Chat with support"
          className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand-green text-white shadow-elevation-2 shadow-brand-ink/20 transition-transform hover:scale-105"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </button>
      )}

      {open && (
        <div className="fixed bottom-5 right-5 z-40 flex h-[520px] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-brand-line bg-white shadow-2xl shadow-brand-ink/25">
          <div className="flex flex-none items-center justify-between bg-brand-ink px-4 py-3 text-white">
            <div>
              <p className="text-sm font-semibold">Chat with Support</p>
              <p className="text-[11px] text-[#C4D0DE]">We usually reply within a few hours</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
              className="rounded-md p-1 text-white/70 hover:bg-white/10 hover:text-white"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto bg-brand-mist/40 p-3">
            {!loaded ? (
              <p className="mt-4 text-center text-xs text-brand-muted">Loading…</p>
            ) : messages.length === 0 ? (
              <p className="mt-4 text-center text-xs text-brand-muted">No messages yet — say hello.</p>
            ) : (
              <div className="space-y-2.5">
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.isMe ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] ${m.isMe ? "items-end" : "items-start"} flex flex-col`}>
                      <div className="mb-0.5 flex items-center gap-1 px-1 text-[10px] text-brand-muted">
                        <span className="font-medium">{m.authorName}</span>
                        {m.isSupport && (
                          <span className="rounded-full bg-brand-green/15 px-1.5 py-0.5 text-[9px] font-semibold text-brand-green-dark">
                            Support
                          </span>
                        )}
                      </div>
                      <div
                        className={`whitespace-pre-wrap rounded-lg px-3 py-1.5 text-[13px] leading-snug ${
                          m.isMe
                            ? "bg-brand-green text-white"
                            : m.isSupport
                              ? "bg-white text-brand-ink ring-1 ring-brand-green-light/40"
                              : "bg-white text-brand-ink shadow-elevation-1"
                        }`}
                      >
                        {m.body}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {sendError && (
            <div className="flex-none border-t border-rose-100 bg-rose-50 px-3 py-1.5 text-xs text-rose-700">
              {sendError}
            </div>
          )}
          <div className="flex flex-none items-end gap-2 border-t border-brand-line bg-white p-3">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Type a message…"
              className="max-h-24 flex-1 resize-none rounded-md border border-brand-line px-2.5 py-1.5 text-[13px] focus:border-brand-green focus:outline-none"
            />
            <button
              type="button"
              onClick={send}
              disabled={!text.trim() || sending}
              className="flex-none rounded-md bg-brand-green px-3 py-1.5 text-[13px] font-display font-bold text-white hover:bg-brand-green-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
