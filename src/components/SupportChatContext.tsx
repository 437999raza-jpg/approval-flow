"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// Lets the sidebar's "Chat with Support" nav item open the SAME floating
// widget instance rather than navigating to a separate page — same
// provider/context shape as ToastContext/DocumentFocusContext elsewhere in
// this app. Authored by Araza.
const SupportChatCtx = createContext<{
  open: boolean;
  setOpen: (v: boolean) => void;
} | null>(null);

export function SupportChatProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <SupportChatCtx.Provider value={{ open, setOpen }}>
      {children}
    </SupportChatCtx.Provider>
  );
}

export function useSupportChat() {
  const ctx = useContext(SupportChatCtx);
  if (!ctx) throw new Error("useSupportChat must be used within SupportChatProvider");
  return ctx;
}
