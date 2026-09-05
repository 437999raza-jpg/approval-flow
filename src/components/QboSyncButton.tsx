"use client";

import { SubmitButton } from "./SubmitButton";
import { useToast } from "./ToastContext";

// A QBO sync button (Sync Suppliers/Categories/Classes/etc. in Settings)
// used to give zero feedback beyond its own spinner while it ran — no
// confirmation the click registered until the page finished reloading a
// few seconds later. This fires a toast the instant it's clicked, on top
// of SubmitButton's existing dim+spinner+disable, so there's an
// immediate, visible acknowledgment even before the request resolves.
// Needs its own client component (not just an onClick prop on
// SubmitButton from the Server Component page) because useToast() can
// only be called from inside a client component. Authored by Araza.
export function QboSyncButton({
  children,
  toastMessage,
  className,
}: {
  children: React.ReactNode;
  toastMessage: string;
  className?: string;
}) {
  const { showToast } = useToast();
  return (
    <SubmitButton className={className} onClick={() => showToast(toastMessage)}>
      {children}
    </SubmitButton>
  );
}
