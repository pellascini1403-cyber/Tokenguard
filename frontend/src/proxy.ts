import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts` (same mechanism, new
 * file/export name). This is the one place session cookies get refreshed
 * on every navigation, and the first line of route protection — see
 * lib/supabase/proxy.ts for what it actually checks.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Skip static assets and Next.js internals — nothing there depends on
     * auth state, and running Supabase's session check against every JS
     * chunk request would be wasted work.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
