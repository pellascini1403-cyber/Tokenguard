/**
 * The 5 bottom-nav positions map to the 5 PNG states the user provided
 * (public/assets/nav/*.png — each one a complete, pre-rendered image of
 * the pill with exactly that tab shown active). "more" has no route of
 * its own — it opens the panel listed in MORE_MENU_LINKS instead.
 */
export type NavTab = "home" | "keys" | "usage" | "requests" | "more";

export interface NavTabConfig {
  tab: NavTab;
  href: string | null;
  label: string;
  activeAssetSrc: string;
}

export const NAV_TABS: NavTabConfig[] = [
  { tab: "home", href: "/overview", label: "Home", activeAssetSrc: "/assets/nav/home-active.png" },
  { tab: "keys", href: "/api-keys", label: "Keys", activeAssetSrc: "/assets/nav/keys-active.png" },
  { tab: "usage", href: "/usage", label: "Usage", activeAssetSrc: "/assets/nav/usage-active.png" },
  {
    tab: "requests",
    href: "/requests",
    label: "Requests",
    activeAssetSrc: "/assets/nav/requests-active.png",
  },
  { tab: "more", href: null, label: "More", activeAssetSrc: "/assets/nav/more-active.png" },
];

/** Original crop's pixel size (public/assets/nav/*.png) — used only to
 * give next/image its intrinsic aspect ratio; rendered size is set by
 * CSS in app-navigation.tsx. */
export const NAV_PILL_INTRINSIC_SIZE = { width: 2463, height: 599 };

export interface MoreMenuLink {
  href: string;
  label: string;
}

export const MORE_MENU_LINKS: MoreMenuLink[] = [
  { href: "/budgets", label: "Budgets" },
  { href: "/alerts", label: "Alerts" },
  { href: "/settings", label: "Settings" },
  { href: "/docs", label: "Documentation" },
  { href: "/settings/members", label: "Members" },
];

/** Routes that live "inside" the More panel — used to decide when the
 * More tab itself should render as the active one. */
const MORE_ROUTE_PREFIXES = ["/budgets", "/alerts", "/settings", "/docs"];

export function resolveActiveTab(pathname: string): NavTab {
  for (const config of NAV_TABS) {
    if (config.href && (pathname === config.href || pathname.startsWith(`${config.href}/`))) {
      return config.tab;
    }
  }
  if (MORE_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return "more";
  }
  return "home";
}
