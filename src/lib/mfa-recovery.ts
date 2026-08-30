"use server";

import { randomBytes, createHash } from "crypto";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Supabase's own auth.mfa API has no backup-code concept (confirmed: its
// GoTrueMFAApi only exposes enroll/challenge/verify/unenroll/listFactors)
// — recovery is built entirely here. A code isn't an ongoing alternate MFA
// factor; it's a one-time "prove it's you, then start over" token, same as
// GitHub/Google backup codes: using one removes 2FA entirely and the user
// re-enrolls fresh, rather than trying to keep it "verified" forever.

const CODE_COUNT = 8;
// Avoids visually-ambiguous characters (0/O, 1/I) since these are meant to
// be hand-copied/read off a saved note.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateOneCode(): string {
  const chars = Array.from({ length: 10 }, () => {
    const idx = randomBytes(1)[0] % CODE_ALPHABET.length;
    return CODE_ALPHABET[idx];
  });
  return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

// Called right after a successful TOTP enrollment (and available again as
// "Regenerate recovery codes" while already enrolled). Replaces any
// existing codes outright — re-enrolling (a new device) shouldn't leave a
// stale set from a lost one still valid, and regenerating is explicitly a
// full reset of the set, not an addition to it.
export async function generateMfaRecoveryCodes(): Promise<string[]> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase.from("mfa_recovery_codes").delete().eq("user_id", user.id);

  const codes = Array.from({ length: CODE_COUNT }, generateOneCode);
  const { error } = await supabase.from("mfa_recovery_codes").insert(
    codes.map((code) => ({
      user_id: user.id,
      code_hash: hashCode(code),
    }))
  );
  if (error) throw new Error(`Could not save recovery codes: ${error.message}`);

  return codes;
}

// The recovery path at /login/mfa for someone who can't complete the
// 6-digit challenge (lost their authenticator device). A valid, unused
// code consumes itself and removes the user's TOTP factor via the ADMIN
// client — deliberately not the user's own session, since Supabase may
// require an already-aal2 session for some MFA management calls, which is
// exactly what a locked-out user doesn't have. Removing the factor is what
// actually clears middleware's AAL requirement on their next request.
export async function redeemMfaRecoveryCode(
  code: string
): Promise<{ ok: boolean; error?: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: "Enter a recovery code." };

  const { data: match } = await supabase
    .from("mfa_recovery_codes")
    .select("id")
    .eq("user_id", user.id)
    .eq("code_hash", hashCode(trimmed))
    .is("used_at", null)
    .maybeSingle();

  if (!match) {
    return { ok: false, error: "That recovery code is invalid or has already been used." };
  }

  await supabase
    .from("mfa_recovery_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("id", match.id);

  const admin = createAdminClient();
  const { data: factorData } = await admin.auth.admin.mfa.listFactors({ userId: user.id });
  const verified = factorData?.factors?.find(
    (f) => f.factor_type === "totp" && f.status === "verified"
  );
  if (verified) {
    await admin.auth.admin.mfa.deleteFactor({ id: verified.id, userId: user.id });
  }

  return { ok: true };
}
