import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getPublicEnv } from "@/lib/env";

const PROTECTED_PREFIXES = [
  "/onboarding",
  "/overview",
  "/usage",
  "/requests",
  "/api-keys",
  "/budgets",
  "/alerts",
  "/settings",
  "/docs",
];

const AUTH_ROUTES = ["/login", "/register", "/forgot-password", "/reset-password"];

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTES.includes(pathname);
}

/**
 * Session refresh + route protection, run on every request that isn't a
 * static asset (see the matcher exported below). This is deliberately
 * thin: it only ever checks "is there a valid Supabase session," never
 * organization membership, role, or onboarding completion — the backend
 * remains the sole authority on all of that, re-checked by every
 * Server Component and Server Action that actually needs it.
 *
 * `getUser()` (not `getSession()`) is used because it revalidates the
 * token against Supabase itself rather than trusting a possibly-stale
 * cookie — the same distinction Supabase's own docs call out for
 * anything that gates access.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const env = getPublicEnv();

  const supabase = createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && isProtectedPath(pathname)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (user && isAuthRoute(pathname)) {
    return NextResponse.redirect(new URL("/overview", request.url));
  }

  return response;
}
