"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={signOut}
      disabled={pending}
      className={`text-sm text-slate-500 hover:text-slate-800 hover:underline ${pending ? "opacity-60" : ""}`}
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
