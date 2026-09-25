"use client";

import { useActiveOrganization } from "@/lib/organizations/context";

export function OrganizationSwitcher() {
  const { organizations, activeOrganization, setActiveOrganizationId, isSwitching } =
    useActiveOrganization();

  if (organizations.length === 0) {
    return null;
  }

  return (
    <label className="flex items-center gap-2 text-sm text-zinc-700">
      <span className="sr-only">Active organization</span>
      <select
        value={activeOrganization?.id ?? ""}
        disabled={isSwitching}
        onChange={(event) => setActiveOrganizationId(event.target.value)}
        className="rounded-md border border-zinc-300 px-2 py-1 text-sm"
      >
        {organizations.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
    </label>
  );
}
