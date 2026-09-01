"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { clsx } from "clsx";
import { ResizeHandle } from "./ResizeHandle";
import { useDocumentFocus } from "./DocumentFocusContext";
import { OrgSwitcher } from "./OrgSwitcher";
import { SignOutButton } from "./SignOutButton";
import { SupportChatProvider } from "./SupportChatContext";
import { SupportChatWidget } from "./SupportChatWidget";

// The one shared app shell — every authenticated page renders this instead
// of hand-rolling its own <aside>. Before this, each page (Settings,
// Workflows, Reports, ...) built its own trimmed-down sidebar independently,
// so navigating away from the Dashboard meant losing the full nav (Settings'
// old sidebar had nothing but "back to dashboard"). One component means one
// place to keep active states, icons, and spacing consistent — and it now
// carries the Support Chat widget everywhere, not just on the Dashboard,
// since the provider travels with it. No separate nav link for it though —
// the widget already puts its own floating launcher bubble in the corner,
// so a second entry point in the nav is redundant.
//
// Owns its own collapse/resize state directly (folded in from the old
// generic Sidebar wrapper, now unused elsewhere) so the collapse toggle can
// live inside the brand bar itself instead of a separate strip above it.
//
// `children` is a slot for page-specific extra nav content rendered right
// under the org header — the Dashboard's per-view invoice list (All
// invoices / Pending Review / ...) is the only current user of it.

const iconProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const icons = {
  dashboard: (
    <svg {...iconProps}>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
  queue: (
    <svg {...iconProps}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  mentions: (
    <svg {...iconProps}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  splits: (
    <svg {...iconProps}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M9 15l2 2 4-4" />
    </svg>
  ),
  workflows: (
    <svg {...iconProps}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" />
    </svg>
  ),
  reports: (
    <svg {...iconProps}>
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 3 3 5-6" />
    </svg>
  ),
  billing: (
    <svg {...iconProps}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  ),
  statements: (
    <svg {...iconProps}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  settings: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  admin: (
    <svg {...iconProps}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  ),
  menu: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
};

type BadgeTone = "green" | "orange" | "slate";
type NavItem = {
  href: string;
  active: boolean;
  icon: ReactNode;
  label: string;
  badge?: number;
  badgeTone?: BadgeTone;
};

function NavLink({
  href,
  active,
  icon,
  children,
  badge,
  badgeTone = "slate",
  pending = false,
  onIntent,
  onPending,
  prefetch,
}: {
  href: string;
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  badge?: number;
  badgeTone?: BadgeTone;
  pending?: boolean;
  onIntent?: () => void;
  onPending?: () => void;
  prefetch?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      title={typeof children === "string" ? children : undefined}
      onMouseEnter={onIntent}
      onFocus={onIntent}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        onPending?.();
      }}
      className={clsx(
        "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
        active
          ? "bg-brand-green/10 font-medium text-brand-green-dark"
          : pending
            ? "bg-brand-mist font-medium text-brand-ink"
          : "text-brand-muted hover:bg-brand-mist hover:text-brand-ink"
      )}
    >
      <span
        className={clsx(
          "flex-none transition-colors duration-150",
          active ? "text-brand-green-dark" : "text-slate-400 group-hover:text-brand-muted"
        )}
      >
        {icon}
      </span>
      <span className="flex-1 truncate">{children}</span>
      {pending && (
        <span
          aria-label="Opening"
          className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-brand-green"
        />
      )}
      {typeof badge === "number" && badge > 0 && (
        <span
          className={clsx(
            "flex-none rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
            badgeTone === "green" && "bg-brand-green/15 text-brand-green-dark",
            badgeTone === "orange" && "bg-amber-100 text-amber-700",
            badgeTone === "slate" && "bg-slate-100 text-slate-500"
          )}
        >
          {badge}
        </span>
      )}
    </Link>
  );
}

function IconRailLink({
  href,
  active,
  icon,
  label,
  badge,
  badgeTone = "slate",
  pending = false,
  onIntent,
  onPending,
  prefetch,
}: {
  href: string;
  active: boolean;
  icon: ReactNode;
  label: string;
  badge?: number;
  badgeTone?: BadgeTone;
  pending?: boolean;
  onIntent?: () => void;
  onPending?: () => void;
  prefetch?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      title={label}
      aria-label={label}
      onMouseEnter={onIntent}
      onFocus={onIntent}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        onPending?.();
      }}
      className={clsx(
        "relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-150",
        active
          ? "bg-brand-green/10 text-brand-green-dark"
          : pending
            ? "bg-brand-mist text-brand-ink"
          : "text-slate-400 hover:bg-brand-mist hover:text-brand-ink"
      )}
    >
      {icon}
      {pending && <span className="absolute bottom-1 h-1 w-1 animate-pulse rounded-full bg-brand-green" />}
      {typeof badge === "number" && badge > 0 && (
        <span
          className={clsx(
            "absolute -right-0.5 -top-0.5 min-w-4 rounded-full px-1 text-center text-[9px] font-bold leading-4",
            badgeTone === "green" && "bg-brand-green text-white",
            badgeTone === "orange" && "bg-amber-500 text-white",
            badgeTone === "slate" && "bg-slate-400 text-white"
          )}
        >
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </Link>
  );
}

export function AppSidebar({
  org,
  user,
  subtitle,
  myOrgs,
  switchOrgAction,
  isPlatformAdmin,
  counts,
  initialSupportOpen = false,
  children,
}: {
  org: { id: string; name: string; role: string };
  user: { email?: string | null };
  subtitle?: ReactNode;
  myOrgs?: { id: string; name: string }[];
  switchOrgAction?: (formData: FormData) => Promise<void>;
  isPlatformAdmin: boolean;
  counts?: { mentions?: number; pendingSplits?: number };
  initialSupportOpen?: boolean;
  children?: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { focused: docFocused } = useDocumentFocus();
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(240);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  // Workflows/Billing/Statements/Reports/Settings are open to anyone but
  // the "user" role; Queue is stricter — admin only (see /queue's own
  // redirect) — so it needs its own check rather than reusing this one.
  const isAdminOrOwner = org.role !== "user";
  const isAdmin = org.role === "admin";
  const is = useCallback((prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`), [pathname]);
  // Dashboard is its own thing, not part of primaryNav below: it's the one
  // route that's client-cached after its first load (see the Dashboard
  // rewrite), so a real page navigation to it essentially never happens
  // again once you're on it — no prefetch/pending affordance to give it.
  const dashboardNavItem: NavItem = useMemo(
    () => ({ href: "/dashboard", active: is("/dashboard"), icon: icons.dashboard, label: "Dashboard" }),
    [is]
  );
  const primaryNav: NavItem[] = useMemo(
    () => [
      ...(isAdmin ? [{ href: "/queue", active: is("/queue"), icon: icons.queue, label: "Queue" }] : []),
      {
        href: "/notifications",
        active: is("/notifications"),
        icon: icons.mentions,
        label: "Mentions",
        badge: counts?.mentions,
        badgeTone: "green" as const,
      },
      {
        href: "/invoices/pending-splits",
        active: is("/invoices/pending-splits"),
        icon: icons.splits,
        label: "Split review",
        badge: counts?.pendingSplits,
        badgeTone: "orange" as const,
      },
    ],
    [counts?.mentions, counts?.pendingSplits, is, isAdmin]
  );
  const secondaryNav: NavItem[] = useMemo(
    () => [
      ...(isAdminOrOwner ? [{ href: "/workflows", active: is("/workflows"), icon: icons.workflows, label: "Workflows" }] : []),
      ...(isAdminOrOwner ? [{ href: "/billing", active: is("/billing"), icon: icons.billing, label: "Billing" }] : []),
      ...(isAdminOrOwner ? [{ href: "/statements", active: is("/statements"), icon: icons.statements, label: "Statements" }] : []),
      { href: "/reports", active: is("/reports"), icon: icons.reports, label: "Reports" },
      { href: "/settings", active: is("/settings"), icon: icons.settings, label: "Settings" },
      ...(isPlatformAdmin
        ? [{ href: "/admin/organizations", active: is("/admin"), icon: icons.admin, label: "Organizations" }]
        : []),
    ],
    [is, isAdminOrOwner, isPlatformAdmin]
  );
  // Shared by every nav item that points at a real server-rendered page —
  // both primaryNav (Queue/Mentions/Split review) and secondaryNav
  // (Workflows..Organizations). Dashboard is the only link that opts out
  // (see dashboardNavItem above).
  const warmRoute = useCallback(
    (href: string) => {
      router.prefetch(href);
    },
    [router]
  );
  const markRoutePending = useCallback(
    (item: NavItem) => {
      if (item.active) return;
      setPendingHref(item.href);
      warmRoute(item.href);
    },
    [warmRoute]
  );

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  useEffect(() => {
    if (!pendingHref) return;
    const timeout = setTimeout(() => setPendingHref(null), 8000);
    return () => clearTimeout(timeout);
  }, [pendingHref]);

  // A document open for the 50/50 split takes the whole screen — not even
  // the collapsed rail stays. collapsed/width are untouched, so whatever
  // state this was in comes right back once the document closes. Support
  // Chat still needs to exist off-screen so its floating bubble/state
  // survives the sidebar disappearing.
  if (docFocused) {
    return (
      <SupportChatProvider initialOpen={initialSupportOpen}>
        <SupportChatWidget />
      </SupportChatProvider>
    );
  }

  if (collapsed) {
    return (
      <SupportChatProvider initialOpen={initialSupportOpen}>
        <aside className="flex w-14 flex-none flex-col items-center border-r border-brand-line bg-white">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            title="Show menu"
            className="flex h-12 w-full items-center justify-center bg-brand-ink text-white transition-colors duration-150 hover:bg-brand-ink/90"
          >
            {icons.menu}
          </button>
          <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
            <div className="flex flex-col items-center gap-1">
              <IconRailLink {...dashboardNavItem} />
              {primaryNav.map((item) => (
                <IconRailLink
                  key={item.href}
                  {...item}
                  prefetch
                  pending={pendingHref === item.href}
                  onIntent={() => warmRoute(item.href)}
                  onPending={() => markRoutePending(item)}
                />
              ))}
            </div>
            <div className="mt-auto flex flex-col items-center gap-1 border-t border-brand-line pt-2">
              {secondaryNav.map((item) => (
                <IconRailLink
                  key={item.href}
                  {...item}
                  prefetch
                  pending={pendingHref === item.href}
                  onIntent={() => warmRoute(item.href)}
                  onPending={() => markRoutePending(item)}
                />
              ))}
            </div>
          </nav>
        </aside>
        <SupportChatWidget />
      </SupportChatProvider>
    );
  }

  return (
    <SupportChatProvider initialOpen={initialSupportOpen}>
      <aside style={{ width }} className="flex flex-none flex-col border-r border-brand-line bg-white">
        <div className="flex items-center justify-between bg-brand-ink px-4 py-3">
          <Link href="/dashboard" title="Go to dashboard">
            <Image
              src="/brand/ufirst-wordmark-white.png"
              alt="ufirst"
              width={2400}
              height={878}
              className="h-4 w-auto"
            />
          </Link>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Collapse menu"
            className="rounded-md p-1 text-white transition-colors duration-150 hover:bg-white/10"
          >
            {icons.menu}
          </button>
        </div>

        <div className="border-b border-brand-line px-4 py-4">
          <div className="eyebrow">Workspace</div>
          <div className="mt-1 truncate font-display text-lg font-bold tracking-tight text-brand-ink">
            {org.name}
          </div>
          {subtitle && <div className="mt-1 truncate text-xs text-brand-muted">{subtitle}</div>}
        </div>

        {children && <div className="border-b border-brand-line p-2">{children}</div>}

        {/* Two independently-anchored groups rather than one flowing list:
            Queue/Mentions/Splits hug the top, Workflows..Settings hug the
            bottom (mt-auto), with whatever space is left between them. */}
        <nav className="flex flex-1 flex-col overflow-y-auto p-2">
          <div className="space-y-0.5">
            <NavLink {...dashboardNavItem}>{dashboardNavItem.label}</NavLink>
            {primaryNav.map((item) => (
              <NavLink
                key={item.href}
                {...item}
                prefetch
                pending={pendingHref === item.href}
                onIntent={() => warmRoute(item.href)}
                onPending={() => markRoutePending(item)}
              >
                {item.label}
              </NavLink>
            ))}
          </div>

          <div className="mt-auto space-y-0.5 pt-2">
            <div className="mb-2 border-t border-brand-line" />
            {secondaryNav.map((item) => (
              <NavLink
                key={item.href}
                {...item}
                prefetch
                pending={pendingHref === item.href}
                onIntent={() => warmRoute(item.href)}
                onPending={() => markRoutePending(item)}
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="border-t border-brand-line p-3">
          {myOrgs && myOrgs.length > 1 && switchOrgAction && (
            <div className="mb-2">
              <OrgSwitcher orgs={myOrgs} currentOrgId={org.id} action={switchOrgAction} />
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-brand-muted">{user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </aside>
      <ResizeHandle onDrag={(dx) => setWidth((w) => Math.min(400, Math.max(160, w + dx)))} />
      <SupportChatWidget />
    </SupportChatProvider>
  );
}
