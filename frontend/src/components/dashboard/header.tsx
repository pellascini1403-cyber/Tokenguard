import { signOutAction } from "@/lib/auth/actions";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { OrganizationSwitcher } from "@/components/dashboard/organization-switcher";

interface HeaderProps {
  userEmail: string | null;
}

export function Header({ userEmail }: HeaderProps) {
  return (
    <header className="relative flex items-center justify-between border-b border-zinc-200 px-4 py-3">
      <div className="flex items-center gap-3">
        <MobileNav />
        <OrganizationSwitcher />
      </div>
      <div className="flex items-center gap-3 text-sm text-zinc-600">
        {userEmail && <span>{userEmail}</span>}
        <form action={signOutAction}>
          <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
