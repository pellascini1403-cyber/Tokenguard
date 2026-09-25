import { NavList } from "@/components/dashboard/nav-list";

/**
 * Desktop sidebar. Deliberately unstyled beyond basic layout — final
 * visual design is out of scope for this step (see the frontend README).
 */
export function Sidebar() {
  return (
    <aside className="hidden w-56 shrink-0 border-r border-zinc-200 px-3 py-6 md:block">
      <p className="px-3 pb-6 text-sm font-semibold text-zinc-900">TokenGuard</p>
      <NavList />
    </aside>
  );
}
