"use client";

import { useEffect } from "react";
import { restoreScrollPosition } from "./ScrollPreserveForm";

// Mount once on a page whose forms use ScrollPreserveForm: after a button
// press navigates (server-action redirect), put the reader back where they
// were instead of dumping them at the top of the page.
export function ScrollRestorer() {
  useEffect(() => {
    restoreScrollPosition();
  }, []);
  return null;
}
