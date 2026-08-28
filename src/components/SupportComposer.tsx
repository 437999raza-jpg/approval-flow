"use client";

import { useState } from "react";
import { SubmitButton } from "./SubmitButton";

// Plain message composer for the support chat — no @mentions needed (the
// whole point is reaching outside the org), just type and send. Clears
// itself after a successful post, same shape as InstructionsBox/
// MentionComposer's own wrap-the-action-to-reset-local-state pattern.
export function SupportComposer({
  postMessage,
}: {
  postMessage: (formData: FormData) => Promise<void>;
}) {
  const [text, setText] = useState("");

  async function handleSubmit(formData: FormData) {
    if (!text.trim()) return;
    await postMessage(formData);
    setText("");
  }

  return (
    <form action={handleSubmit} className="flex items-end gap-2 border-t border-slate-200 bg-white p-4">
      <textarea
        name="body"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        rows={2}
        placeholder="Message support… (Enter to send, Shift+Enter for a new line)"
        className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />
      <SubmitButton
        disabled={!text.trim()}
        className="flex-none rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Send
      </SubmitButton>
    </form>
  );
}
