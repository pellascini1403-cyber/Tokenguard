"use client";

import { useState } from "react";
import { NavList } from "@/components/dashboard/nav-list";

/**
 * Structural mobile navigation only — a toggled panel, no final mobile
 * design (see the frontend README's "Not built yet" list).
 */
export function MobileNav() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls="mobile-nav-panel"
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
      >
        Menu
      </button>
      {isOpen && (
        <div
          id="mobile-nav-panel"
          className="absolute inset-x-0 top-full z-10 border-b border-zinc-200 bg-white px-4 py-3"
        >
          <NavList onNavigate={() => setIsOpen(false)} />
        </div>
      )}
    </div>
  );
}
