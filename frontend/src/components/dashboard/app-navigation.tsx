"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/lib/auth/actions";
import {
  MORE_MENU_LINKS,
  NAV_PILL_INTRINSIC_SIZE,
  NAV_TABS,
  resolveActiveTab,
} from "@/components/dashboard/app-navigation-config";

interface AppNavigationProps {
  userEmail: string | null;
}

/**
 * The bottom tab bar + its "More" panel, built from the 5 final PNG
 * assets the user provided (public/assets/nav/*.png — one complete pill
 * image per active tab, not recreated in CSS/SVG). Each PNG already
 * bakes in which icon looks active, so this component's only job is to
 * pick the right image for the current route and lay real, invisible
 * tap targets on top of it — the pixels themselves are never redrawn.
 */
export function AppNavigation({ userEmail }: AppNavigationProps) {
  const pathname = usePathname();
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const activeTab = isMoreOpen ? "more" : resolveActiveTab(pathname);
  const activeConfig = NAV_TABS.find((config) => config.tab === activeTab) ?? NAV_TABS[0]!;

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[env(safe-area-inset-bottom,1rem)] pt-2"
      >
        <div className="relative w-full max-w-xs">
          <Image
            src={activeConfig.activeAssetSrc}
            alt=""
            aria-hidden="true"
            width={NAV_PILL_INTRINSIC_SIZE.width}
            height={NAV_PILL_INTRINSIC_SIZE.height}
            className="h-14 w-full"
            priority
          />
          <div className="absolute inset-0 flex">
            {NAV_TABS.map((config) => {
              if (config.tab === "more") {
                return (
                  <button
                    key={config.tab}
                    type="button"
                    onClick={() => setIsMoreOpen((open) => !open)}
                    aria-label={config.label}
                    aria-current={activeTab === "more" ? "page" : undefined}
                    aria-expanded={isMoreOpen}
                    aria-controls="more-menu-panel"
                    className="h-full flex-1"
                  />
                );
              }
              return (
                <Link
                  key={config.tab}
                  href={config.href!}
                  aria-label={config.label}
                  aria-current={activeTab === config.tab ? "page" : undefined}
                  className="h-full flex-1"
                />
              );
            })}
          </div>
        </div>
      </nav>

      {isMoreOpen && (
        <MoreMenuPanel userEmail={userEmail} onClose={() => setIsMoreOpen(false)} />
      )}
    </>
  );
}

function MoreMenuPanel({
  userEmail,
  onClose,
}: {
  userEmail: string | null;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        id="more-menu-panel"
        role="dialog"
        aria-modal="true"
        aria-label="More"
        className="relative rounded-t-2xl bg-black px-4 pb-[env(safe-area-inset-bottom,1.5rem)] pt-4 text-white"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-zinc-700" />
        {userEmail && <p className="mt-4 px-1 text-xs text-zinc-400">Signed in as {userEmail}</p>}
        <ul className="mt-2">
          {MORE_MENU_LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={onClose}
                className="block rounded-md px-1 py-3 text-sm font-medium text-white hover:bg-zinc-900"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-1 border-t border-zinc-800 pt-1">
          <form action={signOutAction}>
            <button
              type="submit"
              className="block w-full rounded-md px-1 py-3 text-left text-sm font-medium text-red-400 hover:bg-zinc-900"
            >
              Logout
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
