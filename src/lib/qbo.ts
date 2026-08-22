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
// Match an OCR'd vendor name to a QBO supplier. EXACT match only
// (case/punctuation-insensitive via normalizeForMatching): "TRI-AN ELECTRIC
// 2024 LTD" == "Tri-An Electric 2024 Ltd" match; anything less does not.
//
// This is deliberate: a fuzzy match could silently pair the invoice with the
// wrong supplier and push a mismatched bill to QBO. If there is no exact
// match, we return null and the invoice is flagged so a human fixes the
// vendor before it can sync. Flow never creates suppliers.
export function matchSupplier(
  suppliers: { name: string }[],
  vendorName: string | null | undefined
): string | null {
  const needle = normalizeForMatching(vendorName);
  if (!needle) return null;
  const hit = suppliers.find(
    (s) => normalizeForMatching(s.name) === needle
  );
  return hit?.name ?? null;
}

// READ-ONLY: pull the company's PROJECTS. In QuickBooks, projects live on
// the Customer entity with IsProject=true (they're tracked for project
// profitability). Regular customers (IsProject=false) are NOT imported —
// Flow needs projects, not customers. Nothing is ever written to QBO.
export interface QboProject {
  qboCustomerId: string;
  name: string;
  active: boolean;
}

export async function listProjects(
  conn: QboConnection,
  limit = 2000
): Promise<QboProject[]> {
  // QBO's query language can't filter on IsProject, so fetch all customers
  // (paginated) and keep the ones flagged as projects.
  const all: QboProject[] = [];
  let startPosition = 1;
  while (all.length < limit * 2) {
    const q = `select Id, DisplayName, IsProject, Active from Customer order by DisplayName startposition ${startPosition} maxresults 1000`;
    const res = await qboFetch(conn, `/query?query=${encodeURIComponent(q)}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `QBO: project query failed (HTTP ${res.status}): ${body.slice(0, 300)}`
      );
    }
    const json = (await res.json()) as {
      QueryResponse?: {
        Customer?: { Id: string; DisplayName?: string; IsProject?: boolean; Active?: boolean }[];
      };
    };
    const rows = json.QueryResponse?.Customer ?? [];
    if (rows.length === 0) break;
    for (const c of rows) {
      if (c.IsProject !== true) continue;
      all.push({
        qboCustomerId: c.Id,
        name: c.DisplayName ?? "",
        active: c.Active ?? true,
      });
    }
    if (rows.length < 1000) break;
    startPosition += rows.length;
  }
  return all.slice(0, limit);
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
  acctNum: string | null;
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
    // Categories are the numbered chart of accounts: keep every account
    // whose AcctNum starts with one of the requested prefixes (2-, 5-, 6-).
    accounts = accounts.filter((a) => {
      const num = (a.AcctNum ?? "").trim();
      return acctNumPrefixes.some((p) => num.startsWith(p));
    });
  }
  return accounts
    .slice(0, needsFullList ? 500 : limit)
    .map((a) => ({
      qboAccountId: a.Id,
      name: a.Name ?? "",
      acctNum: a.AcctNum ?? null,
      accountType: a.AccountType ?? null,
      accountSubType: a.AccountSubType ?? null,
      active: a.Active ?? true,
    }));
}

// Display name for a category: "5-15450 - HVAC" (AcctNum + name). Falls
// back to the bare name when there's no account number.
export function categoryDisplayName(c: {
  acctNum?: string | null;
  name: string;
}): string {
  const num = (c.acctNum ?? "").trim();
  return num ? `${num} - ${c.name}` : c.name;
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

export interface QboTaxCode {
  qboTaxCodeId: string;
  name: string; // e.g. "H", "M&E (ON)", "Out of Scope"
  rateValue: number; // resolved purchase-side %, e.g. 13
  active: boolean;
}

// READ-ONLY: pull the company's tax CODES with their resolved purchase
// rate. QBO links each code to its rates via PurchaseTaxRateList →
// TaxRateDetail → TaxRateRef; the code's rate is the sum of the referenced
// ACTIVE rates (e.g. M&E (ON) = 6.5 + 6.5 = 13%). Codes that reference no
// active rate (like G → an inactive GST rate) are skipped — which is why
// Dext/ApprovalMax only shows the usable ones. Nothing is written to QBO.
export async function listTaxCodes(
  conn: QboConnection
): Promise<QboTaxCode[]> {
  const codesRes = await qboFetch(
    conn,
    `/query?query=${encodeURIComponent("select * from TaxCode")}`
  );
  if (!codesRes.ok) {
    const body = await codesRes.text();
    throw new Error(
      `QBO: tax code query failed (HTTP ${codesRes.status}): ${body.slice(0, 300)}`
    );
  }
  const codesJson = (await codesRes.json()) as {
    QueryResponse?: {
      TaxCode?: {
        Id: string;
        Name?: string;
        Active?: boolean;
        PurchaseTaxRateList?: {
          TaxRateDetail?: {
            TaxRateRef?: { value?: string };
            TaxTypeApplicable?: string;
          }[];
        };
      }[];
    };
  };
  const codes = codesJson.QueryResponse?.TaxCode ?? [];

  const ratesRes = await qboFetch(
    conn,
    `/query?query=${encodeURIComponent("select * from TaxRate")}`
  );
  if (!ratesRes.ok) {
    const body = await ratesRes.text();
    throw new Error(
      `QBO: tax rate query failed (HTTP ${ratesRes.status}): ${body.slice(0, 300)}`
    );
  }
  const ratesJson = (await ratesRes.json()) as {
    QueryResponse?: { TaxRate?: { Id: string; RateValue?: number | string; Active?: boolean }[] };
  };
  const rateById = new Map<string, { value: number; active: boolean }>();
  for (const r of ratesJson.QueryResponse?.TaxRate ?? []) {
    const v = Number(r.RateValue);
    if (Number.isFinite(v)) {
      rateById.set(r.Id, { value: v, active: r.Active !== false });
    }
  }

  const result: QboTaxCode[] = [];
  for (const c of codes) {
    if (c.Active === false) continue;
    const details = c.PurchaseTaxRateList?.TaxRateDetail ?? [];
    if (details.length === 0) continue;
    // Only rates that are active on the purchase side count.
    const usable = details
      .map((d) => (d.TaxRateRef?.value ? rateById.get(d.TaxRateRef.value) : undefined))
      .filter((r): r is { value: number; active: boolean } => !!r && r.active);
    if (usable.length === 0) continue;
    const rateValue = usable.reduce((sum, r) => sum + r.value, 0);
    result.push({
      qboTaxCodeId: c.Id,
      name: c.Name ?? "",
      rateValue,
      active: true,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
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

// Find the account id from a category string like "5-15450 - HVAC":
// match by AcctNum first (exact), then by name; fall back to the first
// active Expense account (QBO's "Uncategorized Expense" is usually there).
// Runs a QBO account query and returns the first hit's id, or null. Throws
// (rather than silently returning null) on an HTTP-level failure, so a
// broken query is never mistaken for "no matching account".
async function queryAccountId(
  conn: QboConnection,
  query: string,
  context: string
): Promise<string | null> {
  const res = await qboFetch(conn, `/query?query=${encodeURIComponent(query)}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO: ${context} query failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    QueryResponse?: { Account?: { Id: string; Name?: string }[] };
  };
  return json.QueryResponse?.Account?.[0]?.Id ?? null;
}

// Resolves a bare name (no account number) to a QBO account — used only
// for the "no category set on this line" fallback (sales tax is handled
// natively via TaxCodeRef now, not a manually-resolved account — see
// resolveTaxCode below). Name and AccountType ARE queryable fields
// (unlike AcctNum — see resolveCategoryAccount below for why numbered
// categories never go through a live query at all), so this stays a live
// QBO call.
export async function findExpenseAccount(
  conn: QboConnection,
  name?: string | null
): Promise<string> {
  const raw = name?.trim() ?? "";

  // No category set on this line at all — fall back to a generic expense
  // account rather than blocking the whole bill over a blank field.
  if (!raw) {
    const fallback = await queryAccountId(
      conn,
      "select Id from Account where AccountType = 'Expense' and Active = true maxresults 1",
      "fallback expense account"
    );
    if (fallback) return fallback;
    throw new Error("QBO: no active Expense account exists to fall back to, and this line has no category set.");
  }

  const hit = await queryAccountId(
    conn,
    `select Id from Account where Name = '${raw.replace(/'/g, "''")}' and Active = true`,
    `account name "${raw}"`
  );
  if (hit) return hit;
  throw new Error(`QBO: no active account found named "${raw}".`);
}

// --- Numbered-category resolution (e.g. "5-15450 - HVAC") ----------------
//
// QBO's query language does not support filtering by AcctNum at all —
// confirmed live: `where AcctNum = '5-15450'` returns QBO error 4001,
// "QueryValidationError: property 'AcctNum' is not queryable". AcctNum can
// only be SELECTed, never used in a WHERE clause. So numbered categories
// are resolved against the already-synced qbo_categories mirror (built by
// syncQboCategories in Settings, one row per Chart-of-Accounts account,
// scoped by organization_id — which is scoped to exactly one QBO
// connection/realm, so two orgs can never cross-resolve each other's
// accounts) instead of ever querying QBO live for this.

export interface QboCategoryRow {
  qboAccountId: string;
  name: string;
  acctNum: string | null;
}

// Pure — no I/O, easy to unit-test in isolation. Matches a line's category
// string against an already-fetched local mirror. A category with an
// explicit account-number prefix ("5-15450 - HVAC") is matched ONLY by
// that number — never falls back to a name guess, since the number was a
// specific, deliberate choice and a name-based guess risks silently
// posting to the wrong account. A bare name matches by name. Returns null
// on no match; callers decide what to do (resolveCategoryAccount below
// refreshes the mirror once and retries before failing).
export function matchCategoryAccount(
  categories: QboCategoryRow[],
  category: string | null | undefined
): string | null {
  const raw = category?.trim() ?? "";
  if (!raw) return null;

  const acctMatch = raw.match(/^([0-9]+(?:-[0-9]+)*)\s*[-–—]\s*/);
  if (acctMatch) {
    const acctNum = acctMatch[1].trim();
    return (
      categories.find((c) => (c.acctNum ?? "").trim() === acctNum)
        ?.qboAccountId ?? null
    );
  }

  const needle = raw.toLowerCase();
  return (
    categories.find((c) => c.name.trim().toLowerCase() === needle)
      ?.qboAccountId ?? null
  );
}

// Mutable, shared across every line in one bill so a miss only ever
// triggers a single QBO refresh no matter how many lines miss (requirement:
// "should not issue duplicate QBO account queries").
export interface CategoryAccountCache {
  categories: QboCategoryRow[];
  refreshed: boolean;
}

export async function loadCategoryAccountCache(
  supabase: SupabaseClient<Database>,
  organizationId: string
): Promise<CategoryAccountCache> {
  const { data } = await supabase
    .from("qbo_categories")
    .select("qbo_account_id, name, acct_num")
    .eq("organization_id", organizationId);
  return {
    categories: (data ?? []).map((c) => ({
      qboAccountId: c.qbo_account_id,
      name: c.name,
      acctNum: c.acct_num,
    })),
    refreshed: false,
  };
}

// Resolves ONE line's category against the cache, refreshing the mirror
// from QBO at most once (on the first miss) before failing loudly. Never
// substitutes a different account — a category that still can't be
// resolved after a refresh is a hard failure naming the exact account and
// company, not a guess.
export async function resolveCategoryAccount(
  supabase: SupabaseClient<Database>,
  conn: QboConnection,
  organizationId: string,
  cache: CategoryAccountCache,
  category: string | null | undefined
): Promise<string> {
  const raw = category?.trim() ?? "";
  if (!raw) return findExpenseAccount(conn, null);

  let hit = matchCategoryAccount(cache.categories, raw);
  if (hit) return hit;

  if (!cache.refreshed) {
    cache.refreshed = true;
    const fresh = await listCategories(conn, 500, {
      acctNumPrefixes: ["2", "5", "6"],
    });
    if (fresh.length > 0) {
      await supabase.from("qbo_categories").upsert(
        fresh.map((c) => ({
          organization_id: organizationId,
          qbo_account_id: c.qboAccountId,
          name: c.name,
          acct_num: c.acctNum,
          account_type: c.accountType,
          account_sub_type: c.accountSubType,
          active: c.active,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_account_id" }
      );
    }
    cache.categories = (await loadCategoryAccountCache(supabase, organizationId)).categories;
    hit = matchCategoryAccount(cache.categories, raw);
    if (hit) return hit;
  }

  throw new Error(
    `QBO account "${raw}" was not found in the connected company's Chart of Accounts${
      conn.companyName ? ` (${conn.companyName})` : ` (realm ${conn.realmId})`
    }. Run "Refresh data" in Settings → Data from QuickBooks, or confirm this account exists and is active in QuickBooks.`
  );
}

// --- Sales tax (native QBO TaxCodeRef, not a manual liability line) -----
//
// QBO calculates and posts sales tax itself once a line carries a
// TaxCodeRef and the bill's GlobalTaxCalculation is TaxExcluded — it picks
// the correct tax/liability account on its own from the company's own tax
// settings. Flow must never build its own "Tax" expense/liability line
// (that double-counts and posts to whatever account Flow guesses, which is
// wrong — a vendor bill's tax isn't "Sales Tax Payable", the account for
// tax the business owes on its own sales). So the only job here is:
// resolve the line's selected tax RATE (e.g. 13 for 13% HST) to the QBO
// TaxCode id with that exact resolved rate, using the already-synced
// qbo_tax_codes mirror (rate_value comes from listTaxCodes, migration
// 0040). A line with no tax selected gets no TaxCodeRef at all.

export interface QboTaxCodeRow {
  qboTaxCodeId: string;
  rateValue: number;
}

// Pure — no I/O. Matches a selected tax rate (13) to the one QBO tax code
// with that resolved rate. Never guesses across two codes that happen to
// share a rate (e.g. two provincial codes both at 13%) — ambiguous or
// missing returns null so the caller fails loudly instead of picking one.
export function matchTaxCode(
  codes: QboTaxCodeRow[],
  rate: number | null | undefined
): string | null {
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  const hits = codes.filter((c) => Math.abs(c.rateValue - rate) < 0.005);
  return hits.length === 1 ? hits[0].qboTaxCodeId : null;
}

export interface TaxCodeCache {
  codes: QboTaxCodeRow[];
  refreshed: boolean;
}

export async function loadTaxCodeCache(
  supabase: SupabaseClient<Database>,
  organizationId: string
): Promise<TaxCodeCache> {
  const { data } = await supabase
    .from("qbo_tax_codes")
    .select("qbo_tax_code_id, rate_value")
    .eq("organization_id", organizationId)
    .not("rate_value", "is", null);
  return {
    codes: (data ?? []).map((c) => ({
      qboTaxCodeId: c.qbo_tax_code_id,
      rateValue: Number(c.rate_value),
    })),
    refreshed: false,
  };
}

// Resolves ONE line's tax to a QBO TaxCode id. If the line already carries
// the exact code the user picked (qbo_tax_code_id, saved by the Tax field
// — see Combobox's secondaryName wiring in BillPanel), that's used as-is;
// no ambiguity is possible since it names one specific code directly. Only
// legacy rows saved before that column existed (rate only, no code id)
// fall back to matching by rate — refreshing the mirror from QBO at most
// once (on the first miss) before failing loudly, since two codes can
// share a rate (e.g. "H" and "M&E (ON)" both 13%) and Flow won't guess
// which one to use. A line with no tax selected at all (0/null, no code
// id) resolves to null — no TaxCodeRef, no line, nothing posted. Never
// falls back to a manual liability-account line.
export async function resolveTaxCode(
  supabase: SupabaseClient<Database>,
  conn: QboConnection,
  organizationId: string,
  cache: TaxCodeCache,
  rate: number | null | undefined,
  codeId?: string | null
): Promise<string | null> {
  if (codeId) return codeId;
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null;

  let hit = matchTaxCode(cache.codes, rate);
  if (hit) return hit;

  if (!cache.refreshed) {
    cache.refreshed = true;
    const fresh = await listTaxCodes(conn);
    if (fresh.length > 0) {
      await supabase.from("qbo_tax_codes").upsert(
        fresh.map((c) => ({
          organization_id: organizationId,
          qbo_tax_code_id: c.qboTaxCodeId,
          name: c.name,
          rate_value: c.rateValue,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_tax_code_id" }
      );
    }
    cache.codes = (await loadTaxCodeCache(supabase, organizationId)).codes;
    hit = matchTaxCode(cache.codes, rate);
    if (hit) return hit;
  }

  const ambiguous = cache.codes.filter((c) => Math.abs(c.rateValue - rate) < 0.005).length > 1;
  throw new Error(
    ambiguous
      ? `QBO: ${rate}% matches more than one tax code in ${
          conn.companyName ? conn.companyName : `realm ${conn.realmId}`
        } — Flow won't guess which one applies. Deactivate or rename the duplicate in QuickBooks.`
      : `QBO: no tax code found for ${rate}% in ${
          conn.companyName ? conn.companyName : `realm ${conn.realmId}`
        }. Run "Sync taxes from QuickBooks" in Settings, or confirm a tax code with this rate exists and is active.`
  );
}

// --- Class (e.g. "2022-58") -----------------------------------------

export interface QboClassRow {
  qboClassId: string;
  name: string;
}

// Pure — no I/O. Case-insensitive exact match against the already-synced
// qbo_classes mirror.
export function matchClass(
  classes: QboClassRow[],
  className: string | null | undefined
): string | null {
  const raw = className?.trim() ?? "";
  if (!raw) return null;
  const needle = raw.toLowerCase();
  return classes.find((c) => c.name.trim().toLowerCase() === needle)?.qboClassId ?? null;
}

export interface ClassCache {
  classes: QboClassRow[];
  refreshed: boolean;
}

export async function loadClassCache(
  supabase: SupabaseClient<Database>,
  organizationId: string
): Promise<ClassCache> {
  const { data } = await supabase
    .from("qbo_classes")
    .select("qbo_class_id, name")
    .eq("organization_id", organizationId)
    .eq("active", true);
  return {
    classes: (data ?? []).map((c) => ({ qboClassId: c.qbo_class_id, name: c.name })),
    refreshed: false,
  };
}

// Resolves ONE line's class name to a QBO Class id, refreshing the mirror
// from QBO at most once (on the first miss) before failing loudly. A line
// with no class set resolves to null — no ClassRef, nothing forced.
export async function resolveClass(
  supabase: SupabaseClient<Database>,
  conn: QboConnection,
  organizationId: string,
  cache: ClassCache,
  className: string | null | undefined
): Promise<string | null> {
  const raw = className?.trim() ?? "";
  if (!raw) return null;

  let hit = matchClass(cache.classes, raw);
  if (hit) return hit;

  if (!cache.refreshed) {
    cache.refreshed = true;
    const fresh = await listClasses(conn, 500);
    if (fresh.length > 0) {
      await supabase.from("qbo_classes").upsert(
        fresh.map((c) => ({
          organization_id: organizationId,
          qbo_class_id: c.qboClassId,
          name: c.name,
          active: c.active,
          sub_class: c.subClass,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_class_id" }
      );
    }
    cache.classes = (await loadClassCache(supabase, organizationId)).classes;
    hit = matchClass(cache.classes, raw);
    if (hit) return hit;
  }

  throw new Error(
    `QBO class "${raw}" was not found in ${
      conn.companyName ? conn.companyName : `realm ${conn.realmId}`
    }. Run "Sync classes from QuickBooks" in Settings, or confirm this class exists and is active.`
  );
}

export interface QboBillInput {
  vendorId: string; // resolved QBO Vendor id — Flow never creates suppliers
  billDate: string; // YYYY-MM-DD
  dueDate?: string;
  currency: string;
  docNumber?: string | null; // vendor's own bill/invoice number -> QBO's "Bill no."
  memo?: string; // PrivateNote — not printed on the invoice
  // Every line arrives with an ALREADY-RESOLVED QBO account id, and,
  // if the user selected a tax rate on that line, an ALREADY-RESOLVED
  // QBO TaxCode id (see resolveTaxCode). createBill never resolves a
  // category or tax code itself and never builds its own tax line — QBO
  // calculates and posts sales tax on its own from each line's TaxCodeRef.
  lines: {
    description?: string | null;
    amount: number;
    accountId: string;
    taxCodeId?: string | null;
    classId?: string | null; // resolved QBO Class id (see resolveClass)
    customerId?: string | null; // resolved QBO Customer/Project id (projects.qbo_id)
  }[];
}

export interface QboBillResult {
  billId: string;
  docNumber: string | null;
}

// QBO rejects the Bill's CurrencyRef property outright — a 2010
// ValidationFault ("Request has invalid or unsupported property"), not
// just a no-op — on any company that doesn't have multicurrency turned
// on, which is the normal state for a single-currency (e.g. CAD-only)
// company. Per Intuit's own Bill entity docs: "CurrencyRef — Required
// only if multicurrency is enabled for the company. Do not use this
// field if multicurrency is not enabled." Checked via the /preferences
// endpoint's CurrencyPrefs.MultiCurrencyEnabled flag; defaults to false
// (omit CurrencyRef) if the check itself fails, since that's the far
// more common — and far safer — company configuration.
async function isMultiCurrencyEnabled(conn: QboConnection): Promise<boolean> {
  try {
    const res = await qboFetch(conn, "/preferences");
    if (!res.ok) return false;
    const json = (await res.json()) as {
      Preferences?: { CurrencyPrefs?: { MultiCurrencyEnabled?: boolean } };
    };
    return json.Preferences?.CurrencyPrefs?.MultiCurrencyEnabled === true;
  } catch {
    return false;
  }
}

export async function createBill(
  conn: QboConnection,
  input: QboBillInput
): Promise<QboBillResult> {
  const vendorId = input.vendorId;

  const lines: Record<string, unknown>[] = [];
  let seq = 1;
  let hasTaxCode = false;
  for (const line of input.lines) {
    if (!line.amount) continue;
    if (line.taxCodeId) hasTaxCode = true;
    lines.push({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: line.amount,
      LineNum: seq++,
      Description: line.description ?? undefined,
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: line.accountId },
        ...(line.taxCodeId ? { TaxCodeRef: { value: line.taxCodeId } } : {}),
        ...(line.classId ? { ClassRef: { value: line.classId } } : {}),
        ...(line.customerId ? { CustomerRef: { value: line.customerId } } : {}),
      },
    });
  }
  if (lines.length === 0) throw new Error("QBO: bill has no line items");

  const multiCurrency = await isMultiCurrencyEnabled(conn);
  const body: Record<string, unknown> = {
    VendorRef: { value: vendorId },
    Line: lines,
    ...(multiCurrency ? { CurrencyRef: { value: input.currency } } : {}),
    // Line amounts are entered tax-exclusive; QBO computes and posts the
    // tax itself from each line's TaxCodeRef when this is set — Flow never
    // builds its own tax line.
    ...(hasTaxCode ? { GlobalTaxCalculation: "TaxExcluded" } : {}),
    DueDate: input.dueDate ?? undefined,
    TxnDate: input.billDate,
    DocNumber: input.docNumber?.trim() || undefined,
    PrivateNote: input.memo ?? undefined,
  };

  const requestJson = JSON.stringify(body);
  const res = await qboFetch(conn, "/bill", {
    method: "POST",
    body: requestJson,
  });
  if (!res.ok) {
    const text = await res.text();
    // Include exactly what we sent — QBO's "invalid or unsupported
    // property" (2010) errors don't reliably name the actual offending
    // property (the "Property Name:" text is often boilerplate, not a
    // literal field name), so without the request body itself this class
    // of error is unguessable from the response alone.
    throw new Error(
      `QBO: create bill failed (${res.status}): ${text} | Sent: ${requestJson.slice(0, 1500)}`
    );
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
