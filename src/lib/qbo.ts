import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { normalizeForMatching } from "@/lib/matching";

// QuickBooks Online integration: OAuth2 (three-legged), token refresh,
// bill creation, and document attachment (audit PDF + invoice files).
//
// Env:
//   QBO_CLIENT_ID / QBO_CLIENT_SECRET  — Intuit Developer app credentials
//   QBO_REDIRECT_URI                   — e.g. http://localhost:3210/api/qbo/callback
//                                         (must be registered in the Intuit app)
//
// Authored by Araza.

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const SCOPE = "com.intuit.quickbooks.accounting";
const API = (realmId: string) =>
  `https://quickbooks.api.intuit.com/v3/company/${realmId}`;

export function qboEnv() {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const redirectUri = process.env.QBO_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function qboAuthorizeUrl(orgId: string): string | null {
  const env = qboEnv();
  if (!env) return null;
  const params = new URLSearchParams({
    client_id: env.clientId,
    response_type: "code",
    scope: SCOPE,
    redirect_uri: env.redirectUri,
    state: orgId,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
  realmId: string;
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResult> {
  const env = qboEnv();
  if (!env) throw new Error("QBO not configured");
  const basic = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString(
    "base64"
  );
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO token request failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    realmId?: string;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    realmId: json.realmId ?? "",
  };
}

export async function exchangeCodeForTokens(
  code: string
): Promise<TokenResult> {
  const env = qboEnv();
  if (!env) throw new Error("QBO not configured");
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: env.redirectUri,
    })
  );
}

export async function refreshTokens(
  refreshToken: string
): Promise<TokenResult> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })
  );
}

export interface QboConnection {
  realmId: string;
  companyName: string | null;
  accessToken: string;
}

// Fetch the org's QBO connection, transparently refreshing the access token
// when it has expired. Returns null when not connected or refresh fails.
export async function getQboConnection(
  supabase: SupabaseClient<Database>,
  organizationId: string
): Promise<QboConnection | null> {
  const { data } = await supabase
    .from("qbo_connections")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!data) return null;

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    try {
      const refreshed = await refreshTokens(data.refresh_token);
      await supabase
        .from("qbo_connections")
        .update({
          access_token: refreshed.accessToken,
          refresh_token: refreshed.refreshToken,
          expires_at: new Date(
            Date.now() + refreshed.expiresIn * 1000
          ).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", data.id);
      return {
        realmId: data.realm_id,
        companyName: data.company_name,
        accessToken: refreshed.accessToken,
      };
    } catch {
      return null;
    }
  }

  return {
    realmId: data.realm_id,
    companyName: data.company_name,
    accessToken: data.access_token,
  };
}

async function qboFetch(
  conn: QboConnection,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${API(conn.realmId)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

// Find (or create) the vendor by display name; returns the QBO vendor id.
// Creation failures are reported with QBO's actual error, and if the create
// is rejected (usually because a vendor already exists under a slightly
// different spelling), a loose case/punctuation-insensitive lookup picks
// up the existing vendor.
export async function ensureVendor(
  conn: QboConnection,
  name: string
): Promise<string> {
  const escaped = name.replace(/'/g, "''");

  // 1) Exact display-name match first.
  const q = `select Id from Vendor where DisplayName = '${escaped}' and Active = true`;
  const res = await qboFetch(conn, `/query?query=${encodeURIComponent(q)}`);
  const json = (await res.json()) as {
    QueryResponse?: { Vendor?: { Id: string }[] };
  };
  const existing = json.QueryResponse?.Vendor?.[0];
  if (existing) return existing.Id;

  // 2) Try to create it.
  const create = await qboFetch(conn, "/vendor", {
    method: "POST",
    body: JSON.stringify({ DisplayName: name, CompanyName: name }),
  });
  const createText = await create.text();
  let created: { Vendor?: { Id: string } } | null = null;
  try {
    created = JSON.parse(createText) as { Vendor?: { Id: string } };
  } catch {
    // not JSON — will fall through to the loose lookup
  }
  const id = created?.Vendor?.Id;
  if (id) return id;

  // 3) Create failed — most likely the vendor already exists with a
  //    different spelling/punctuation (e.g. "TRI-AN ELECTRIC 2024 LTD"
  //    vs "TRI-AN ELECTRIC 2024 LTD."). Find it via a loose LIKE + the
  //    same normalization used for duplicate/supplier matching.
  const short = name.slice(0, 40).replace(/'/g, "''");
  const loose = `select Id, DisplayName from Vendor where DisplayName like '%${short}%' and Active = true maxresults 25`;
  const looseRes = await qboFetch(conn, `/query?query=${encodeURIComponent(loose)}`);
  const looseJson = (await looseRes.json()) as {
    QueryResponse?: { Vendor?: { Id: string; DisplayName?: string }[] };
  };
  const needle = normalizeForMatching(name);
  const match = (looseJson.QueryResponse?.Vendor ?? []).find(
    (v) => normalizeForMatching(v.DisplayName ?? "") === needle
  );
  if (match) return match.Id;

  throw new Error(
    `QBO: could not create vendor "${name}" (HTTP ${create.status}): ${createText.slice(0, 300)}`
  );
}

// Find the account id by name; fall back to the first active Expense
// account (QBO's default "Uncategorized Expense" is usually there).
export async function findExpenseAccount(
  conn: QboConnection,
  name?: string | null
): Promise<string> {
  if (name) {
    const q = `select Id from Account where Name = '${name.replace(/'/g, "''")}' and Active = true`;
    const res = await qboFetch(conn, `/query?query=${encodeURIComponent(q)}`);
    const json = (await res.json()) as {
      QueryResponse?: { Account?: { Id: string }[] };
    };
    const hit = json.QueryResponse?.Account?.[0];
    if (hit) return hit.Id;
  }
  const q =
    "select Id from Account where AccountType = 'Expense' and Active = true maxresults 1";
  const res = await qboFetch(conn, `/query?query=${encodeURIComponent(q)}`);
  const json = (await res.json()) as {
    QueryResponse?: { Account?: { Id: string }[] };
  };
  const fallback = json.QueryResponse?.Account?.[0];
  if (fallback) return fallback.Id;
  throw new Error("QBO: no expense account found");
}

export interface QboBillInput {
  vendorName: string;
  billDate: string; // YYYY-MM-DD
  dueDate?: string;
  currency: string;
  memo?: string; // PrivateNote — not printed on the invoice
  lines: {
    description?: string | null;
    amount: number;
    account?: string | null;
  }[];
  taxAmount: number;
}

export interface QboBillResult {
  billId: string;
  docNumber: string | null;
}

export async function createBill(
  conn: QboConnection,
  input: QboBillInput
): Promise<QboBillResult> {
  const vendorId = await ensureVendor(conn, input.vendorName);

  const lines: Record<string, unknown>[] = [];
  let seq = 1;
  for (const line of input.lines) {
    if (!line.amount) continue;
    const accountId = await findExpenseAccount(conn, line.account);
    lines.push({
      DetailType: "AccountBasedExpenseDetail",
      Amount: line.amount,
      LineNum: seq++,
      Description: line.description ?? undefined,
      AccountBasedExpenseDetail: {
        AccountRef: { value: accountId },
      },
    });
  }
  if (input.taxAmount > 0) {
    const taxAccount = await findExpenseAccount(conn, "Sales Tax Payable");
    lines.push({
      DetailType: "AccountBasedExpenseDetail",
      Amount: input.taxAmount,
      LineNum: seq++,
      Description: "Tax",
      AccountBasedExpenseDetail: { AccountRef: { value: taxAccount } },
    });
  }
  if (lines.length === 0) throw new Error("QBO: bill has no line items");

  const body: Record<string, unknown> = {
    VendorRef: { value: vendorId },
    Line: lines,
    CurrencyRef: { value: input.currency },
    DueDate: input.dueDate ?? undefined,
    TxnDate: input.billDate,
    PrivateNote: input.memo ?? undefined,
  };

  const res = await qboFetch(conn, "/bill", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO: create bill failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as {
    Bill?: { Id: string; DocNumber?: string };
  };
  const bill = json.Bill;
  if (!bill?.Id) throw new Error("QBO: no bill id in response");
  return { billId: bill.Id, docNumber: bill.DocNumber ?? null };
}

// Attach files to the bill (audit PDF + all invoice documents).
export async function attachDocuments(
  conn: QboConnection,
  billId: string,
  attachments: { name: string; mimeType: string; data: Uint8Array }[]
): Promise<void> {
  if (attachments.length === 0) return;
  const form = new FormData();
  attachments.forEach((a, i) => {
    const idx = String(i + 1).padStart(2, "0");
    form.append(
      `file_metadata_${idx}`,
      JSON.stringify({
        FileName: a.name,
        ContentType: a.mimeType,
        AttachableRef: [
          { EntityRef: { type: "Bill", value: billId } },
        ],
      })
    );
    form.append(`file_content_${idx}`, new Blob([a.data as BlobPart], { type: a.mimeType }), a.name);
  });

  const res = await fetch(`${API(conn.realmId)}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.accessToken}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO: upload failed (${res.status}): ${text}`);
  }
}

// Deep link to the bill in the QBO web app.
export function qboBillUrl(realmId: string, billId: string): string {
  return `https://qbo.intuit.com/app/bill?txnId=${billId}`;
}
