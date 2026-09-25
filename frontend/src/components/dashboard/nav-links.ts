export interface NavLink {
  href: string;
  label: string;
}

export const NAV_LINKS: NavLink[] = [
  { href: "/overview", label: "Overview" },
  { href: "/usage", label: "Usage" },
  { href: "/requests", label: "Requests" },
  { href: "/api-keys", label: "API Keys" },
  { href: "/budgets", label: "Budgets" },
  { href: "/alerts", label: "Alerts" },
  { href: "/settings", label: "Settings" },
  { href: "/docs", label: "Docs" },
];
