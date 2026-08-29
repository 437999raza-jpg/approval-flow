"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { DocumentSearchFilters } from "@/components/DocumentSearchModal";

// A handful of words that signal "this is a sentence, not a literal
// vendor/file/invoice# to substring-match" — e.g. "show me invoices from
// Sat Metal that aren't approved yet". Kept deliberately small: most
// searches (typing a vendor name) should stay instant and free, never
// touching the AI path below. Authored by Araza.
const NL_CUE_WORDS = new Set([
  "from", "not", "only", "waiting", "approved", "pending", "who", "show",
  "find", "still", "before", "after", "over", "under", "between", "is",
  "are", "that", "yet",
]);

// Recognized without ever hitting the AI endpoint — free, instant, no
// chance of a model deciding to search for a vendor literally named
// "clear". Matches "clear filter(s)", "reset the search", "remove all
// filters", etc. (typed or spoken).
const CLEAR_INTENT = /^(clear|reset|remove)( the| all)*( filters?| search)+$/i;

// Chrome's speech recognition auto-appends a period (sometimes a comma or
// "?") to what it decides is a finished sentence — "clear filter" comes
// back as "clear filter.", which fails an exact match against CLEAR_INTENT
// or looks like an extra word to anything else checking word boundaries.
// Stripped once, up front, so voice and typed input behave identically.
function stripTrailingPunctuation(query: string): string {
  return query.trim().replace(/[.,!?]+$/, "").trim();
}

function isClearIntent(query: string): boolean {
  return CLEAR_INTENT.test(query.trim());
}

function looksLikeNaturalLanguage(query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // 2+ words covers plain multi-word names too ("Clarington Toyota",
  // "Sat Metal") — the AI path still resolves those correctly against the
  // org's real vendor/project list (better than a strict substring match
  // would), it's just not free/instant like a single-word search stays.
  if (words.length >= 2) return true;
  return words.some((w) => NL_CUE_WORDS.has(w));
}

// Minimal shape of the browser's built-in Web Speech API — not in TS's
// default DOM lib. Chrome/Edge only (Safari/Firefox don't implement it);
// the mic button just doesn't render when it's unavailable. Runs entirely
// in the browser (Google's free on-device/cloud recognition for Chrome),
// no API key, no per-use cost — unlike a server-side transcription
// service, which would bill per audio minute.
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function SearchInput({
  defaultValue,
  placeholder = "Search vendor, file, invoice #...",
}: {
  defaultValue: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(defaultValue);
  const [pending, setPending] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef("");

  useEffect(() => {
    setVoiceSupported(getSpeechRecognitionCtor() !== null);
  }, []);

  function plainSubmit(next: string) {
    const params = new URLSearchParams(searchParams);
    if (next) params.set("q", next);
    else params.delete("q");
    router.push(`${pathname}?${params.toString()}`);
  }

  // Used when the AI path comes up empty — a fresh /dashboard?q=... rather
  // than plainSubmit's merge-with-current-params, since "current params"
  // at that point is often a PREVIOUS AI search's leftover filters (e.g.
  // supplier=X from the last query), which shouldn't silently carry over
  // into an unrelated one that failed to parse.
  function cleanFallbackSubmit(query: string) {
    router.push(`/dashboard?q=${encodeURIComponent(query)}`);
  }

  async function aiSubmit(query: string) {
    setPending(true);
    try {
      const res = await fetch("/api/dashboard/nl-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const json = (await res.json()) as { filters: Partial<DocumentSearchFilters> | null };
      if (!json.filters) {
        cleanFallbackSubmit(query);
        return;
      }
      const f = json.filters;
      const params = new URLSearchParams();
      if (f.status?.length) params.set("status", f.status.join(","));
      if (f.holder?.length) params.set("holder", f.holder.join(","));
      if (f.requester?.length) params.set("requester", f.requester.join(","));
      if (f.approvedBy?.length) params.set("approvedBy", f.approvedBy.join(","));
      if (f.supplier?.length) params.set("supplier", f.supplier.join(","));
      if (f.customer?.length) params.set("customer", f.customer.join(","));
      if (f.number) params.set("number", f.number);
      if (f.dateFrom) params.set("dateFrom", f.dateFrom);
      if (f.dateTo) params.set("dateTo", f.dateTo);
      if (f.amountFrom) params.set("amountFrom", f.amountFrom);
      if (f.amountTo) params.set("amountTo", f.amountTo);
      setValue("");
      router.push(`/dashboard${params.toString() ? `?${params.toString()}` : ""}`);
    } catch {
      // Best-effort — a failed AI call still lets the user's typed text
      // through as a plain literal search rather than dead-ending.
      cleanFallbackSubmit(query);
    } finally {
      setPending(false);
    }
  }

  function submit(next: string) {
    const trimmed = stripTrailingPunctuation(next);
    if (trimmed && isClearIntent(trimmed)) {
      setValue("");
      router.push(pathname);
      return;
    }
    if (trimmed && looksLikeNaturalLanguage(trimmed)) aiSubmit(trimmed);
    else plainSubmit(trimmed);
  }

  function toggleVoice() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    transcriptRef.current = "";
    recognition.onresult = (e) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
      }
      transcriptRef.current = transcript;
      setValue(transcript);
    };
    recognition.onend = () => {
      setListening(false);
      if (transcriptRef.current.trim()) submit(transcriptRef.current);
    };
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  return (
    <div className="relative w-full">
      <input
        type="search"
        placeholder={pending ? "Reading your search…" : listening ? "Listening…" : placeholder}
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit(value)}
        onBlur={() => !pending && submit(value)}
        className={`w-full rounded-md border border-slate-300 bg-white py-1.5 pl-3 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none disabled:bg-slate-50 ${
          voiceSupported ? "pr-9" : "pr-3"
        }`}
      />
      {pending && (
        <div className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
      )}
      {!pending && voiceSupported && (
        <button
          type="button"
          onClick={toggleVoice}
          title={listening ? "Stop listening" : "Search by voice"}
          className={`absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full ${
            listening ? "bg-red-100 text-red-600" : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          }`}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
            <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
            <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.07A7 7 0 0 0 19 11z" />
          </svg>
        </button>
      )}
    </div>
  );
}
