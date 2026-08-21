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
    realmId?: string | number;
  };
  // Intuit returns the QBO company id as "realmId" in the token response.
  // It is REQUIRED — without it every API call fails with 3100
  // (ApplicationAuthorizationFailed) because the company context is empty.
  const realmId =
    typeof json.realmId === "string" || typeof json.realmId === "number"
      ? String(json.realmId)
      : "";
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    realmId,
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

// READ-ONLY: pull the company's suppliers (Vendor list). Flow NEVER creates
// suppliers in QuickBooks — this mirror is what OCR matching runs against.
export interface QboSupplier {
  qboVendorId: string;
  name: string; // QBO DisplayName
  active: boolean;
}

export async function listSuppliers(
  conn: QboConnection,
  limit = 5000
): Promise<QboSupplier[]> {
  // QBO caps query results at 1000 per call, so page through.
  const all: QboSupplier[] = [];
  let startPosition = 1;
  while (all.length < limit) {
    const pageSize = Math.min(1000, limit - all.length);
    const q = `select Id, DisplayName, Active from Vendor where Active = true order by DisplayName startposition ${startPosition} maxresults ${pageSize}`;
    const res = await qboFetch(conn, `/query?query=${encodeURIComponent(q)}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `QBO: supplier query failed (HTTP ${res.status}): ${body.slice(0, 300)}`
      );
    }
    const json = (await res.json()) as {
      QueryResponse?: {
        Vendor?: { Id: string; DisplayName?: string; Active?: boolean }[];
      };
    };
    const rows = json.QueryResponse?.Vendor ?? [];
    if (rows.length === 0) break;
    for (const v of rows) {
      if (v.Active === false) continue;
      all.push({
        qboVendorId: v.Id,
        name: v.DisplayName ?? "",
        active: v.Active ?? true,
      });
    }
    if (rows.length < pageSize) break;
    startPosition += rows.length;
  }
  return all;
}

// Match an OCR'd vendor name to the nearest supplier already in QBO
// (case/punctuation-insensitive, like the duplicate-matching normalizer).
// Returns null when nothing is close enough — the bill then can't sync
// until the supplier exists in QBO. Flow never creates suppliers.
export function matchSupplier(
  suppliers: { name: string }[],
  vendorName: string | null | undefined
): string | null {
  const needle = normalizeForMatching(vendorName);
  if (!needle) return null;

  // Exact normalized match first.
  const exact = suppliers.find(
    (s) => normalizeForMatching(s.name) === needle
  );
  if (exact) return exact.name;

  // Then: every token of the needle present in the supplier name (in any
  // order) — catches "TRI-AN ELECTRIC 2024 LTD" vs "TRI-AN ELECTRIC 2024
  // LTD." and small OCR deviations, without fuzzy-matching random names.
  const needleTokens = needle.split(" ").filter(Boolean);
  if (needleTokens.length >= 2) {
    const subset = suppliers.find((s) => {
      const nameTokens = new Set(normalizeForMatching(s.name).split(" "));
      return needleTokens.every((t) => nameTokens.has(t));
    });
    if (subset) return subset.name;
  }
  return null;
}

// READ-ONLY: pull the company's Chart of Accounts (categories). This is the
// only QBO interaction that should happen for now — nothing is ever written
// to QuickBooks from the categories flow, and no vendor data is fetched.
//
// Options:
//   taxOnly         — only accounts whose name looks like a tax account
//   acctNumPrefixes — only accounts whose AcctNum starts with one of these
//                     prefixes (e.g. ["5","6"] = Division 5 & 6 — the bill
//                     categories in a CSI-numbered chart of accounts).
// QBO's query language can't OR several LIKE patterns, so we fetch active
// accounts once and filter in code — cheap at this company's size.
const TAX_NAME_PATTERN =
  /(^|[^a-z])(gst|hst|pst|qst|vat|tax|ministry of revenue|revenue agency)([^a-z]|$)/i;

export interface QboCategory {
  qboAccountId: string;
  name: string;
  accountType: string | null;
  accountSubType: string | null;
  active: boolean;
}

export async function listCategories(
  conn: QboConnection,
  limit = 10,
  opts: { taxOnly?: boolean; acctNumPrefixes?: string[] } = {}
): Promise<QboCategory[]> {
  const { taxOnly = false, acctNumPrefixes } = opts;
  // Filtering modes need the full active list; otherwise honor the limit.
  const needsFullList = taxOnly || (acctNumPrefixes && acctNumPrefixes.length > 0);
  const q = needsFullList
    ? "select Id, Name, AcctNum, AccountType, AccountSubType, Active from Account where Active = true maxresults 1000"
    : `select Id, Name, AcctNum, AccountType, AccountSubType, Active from Account where Active = true order by Name maxresults ${limit}`;
  const res = await qboFetch(conn, `/query?query=${encodeURIComponent(q)}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `QBO: category query failed (HTTP ${res.status}): ${body.slice(0, 300)}`
    );
  }
  const json = (await res.json()) as {
    QueryResponse?: {
      Account?: {
        Id: string;
        Name?: string;
        AcctNum?: string | null;
        AccountType?: string;
        AccountSubType?: string;
        Active?: boolean;
      }[];
    };
  };
  let accounts = json.QueryResponse?.Account ?? [];
  if (taxOnly) {
    accounts = accounts.filter((a) => TAX_NAME_PATTERN.test(a.Name ?? ""));
  }
  if (acctNumPrefixes && acctNumPrefixes.length > 0) {
    // Division 5/6 = Cost of Goods Sold + Expense (the bill categories).
    // Drop balance-sheet strays like A/P that happen to have a matching
    // account number prefix.
    accounts = accounts.filter((a) => {
      const num = (a.AcctNum ?? "").trim();
      if (!acctNumPrefixes.some((p) => num.startsWith(p))) return false;
      const type = a.AccountType ?? "";
      return type === "Cost of Goods Sold" || type === "Expense";
    });
  }
  return accounts
    .slice(0, needsFullList ? 500 : limit)
    .map((a) => ({
      qboAccountId: a.Id,
      name: a.Name ?? "",
      accountType: a.AccountType ?? null,
      accountSubType: a.AccountSubType ?? null,
      active: a.Active ?? true,
    }));
}

export interface QboTaxRate {
  qboTaxRateId: string;
  name: string;
  rateValue: number; // e.g. 5 for 5%
}

// READ-ONLY: pull the company's tax RATES (the % applied to bills, e.g.
// GST 5%, HST 13%). QBO only supports `select *` on TaxRate, so we filter
// and dedupe by percentage in code. Inactive/zero/adjustment rates are
// excluded; among duplicate percentages the purchase-side rate wins.
export async function listTaxRates(conn: QboConnection): Promise<QboTaxRate[]> {
  const q = "select * from TaxRate";
  const res = await qboFetch(conn, `/query?query=${encodeURIComponent(q)}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `QBO: tax rate query failed (HTTP ${res.status}): ${body.slice(0, 300)}`
    );
  }
  const json = (await res.json()) as {
    QueryResponse?: {
      TaxRate?: {
        Id: string;
        Name?: string;
        RateValue?: number | string | null;
        Active?: boolean;
      }[];
    };
  };
  const rates = json.QueryResponse?.TaxRate ?? [];

  // Keep active rates with a positive numeric value; dedupe by percentage,
  // preferring names that mention purchases (bills are purchases).
  const byValue = new Map<number, QboTaxRate>();
  for (const t of rates) {
    if (t.Active === false) continue;
    const v = Number(t.RateValue);
    if (!Number.isFinite(v) || v <= 0) continue;
    const existing = byValue.get(v);
    const name = t.Name ?? "";
    const candidate = { qboTaxRateId: t.Id, name, rateValue: v };
    if (
      !existing ||
      (name.toLowerCase().includes("purchase") &&
        !existing.name.toLowerCase().includes("purchase"))
    ) {
      byValue.set(v, candidate);
    }
  }
  return [...byValue.values()].sort((a, b) => a.rateValue - b.rateValue);
}

export interface QboClass {
  qboClassId: string;
  name: string;
  active: boolean;
  subClass: boolean;
}

// READ-ONLY: pull the company's Classes (e.g. project numbers like
// "2021-56"). Nothing is ever written to QuickBooks here.
export async function listClasses(
  conn: QboConnection,
  limit = 200
): Promise<QboClass[]> {
  const q = `select * from Class maxresults ${limit}`;
  const res = await qboFetch(conn, `/query?query=${encodeURIComponent(q)}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `QBO: class query failed (HTTP ${res.status}): ${body.slice(0, 300)}`
    );
  }
  const json = (await res.json()) as {
    QueryResponse?: {
      Class?: {
        Id: string;
        Name?: string;
        Active?: boolean;
        SubClass?: boolean;
      }[];
    };
  };
  return (json.QueryResponse?.Class ?? []).map((c) => ({
    qboClassId: c.Id,
    name: c.Name ?? "",
    active: c.Active ?? true,
    subClass: c.SubClass ?? false,
  }));
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
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `QBO: account lookup failed (HTTP ${res.status}): ${body.slice(0, 300)}`
      );
    }
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
  vendorId: string; // resolved QBO Vendor id — Flow never creates suppliers
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
  const vendorId = input.vendorId;

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
