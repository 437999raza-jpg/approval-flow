"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// Shared between Sidebar, the invoice list pane, and DetailSplit on the
// dashboard: when a document is opened for a 50/50 split with the bill,
// everything else (the hamburger sidebar, the invoice list column) gets
// out of the way entirely instead of just shrinking to its usual collapsed
// rail, so the two panes that matter get the whole screen. Closing the
// document restores each one to whatever state it was already in — this
// only ever hides them, it never touches their own open/collapsed state.
interface DocumentFocusContextValue {
  focused: boolean;
  setFocused: (focused: boolean) => void;
}

const DocumentFocusContext = createContext<DocumentFocusContextValue | null>(null);

export function DocumentFocusProvider({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState(false);
  return (
    <DocumentFocusContext.Provider value={{ focused, setFocused }}>
      {children}
    </DocumentFocusContext.Provider>
  );
}

// Falls back to "never focused" outside a provider so Sidebar/
// CollapsiblePane stay safe to reuse anywhere else without this context.
export function useDocumentFocus(): DocumentFocusContextValue {
  const ctx = useContext(DocumentFocusContext);
  return ctx ?? { focused: false, setFocused: () => {} };
}
