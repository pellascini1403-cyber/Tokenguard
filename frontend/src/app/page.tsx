import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/session";

/**
 * "/" is intentionally not a marketing page (out of scope for this step
 * — see the frontend README's "Not built yet" list). It only decides
 * where to send the visitor: signed in goes to the dashboard, signed out
 * goes to login.
 */
export default async function RootPage() {
  const session = await getServerSession();
  redirect(session ? "/overview" : "/login");
}
