import type { ReactNode } from "react";

/**
 * Minimal centered auth shell. No branding/visual design beyond basic
 * layout — see the frontend README's "Not built yet" list.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm space-y-6">
        <p className="text-center text-lg font-semibold text-zinc-900">TokenGuard</p>
        {children}
      </div>
    </div>
  );
}
