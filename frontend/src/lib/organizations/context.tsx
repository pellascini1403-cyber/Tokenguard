"use client";

import { createContext, useContext, useMemo, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Organization } from "@/types/organization";
import { setActiveOrganizationAction } from "@/lib/organizations/active-organization";

interface OrganizationContextValue {
  organizations: Organization[];
  activeOrganization: Organization | null;
  setActiveOrganizationId: (organizationId: string) => void;
  isSwitching: boolean;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null);

interface OrganizationProviderProps {
  organizations: Organization[];
  activeOrganizationId: string | null;
  children: ReactNode;
}

/**
 * Client-side view of the organizations the signed-in user belongs to,
 * seeded entirely from a server-fetched list (see /overview and the
 * dashboard layout) — never fetched or cached independently in the
 * browser. Switching organizations writes a cookie via a Server Action
 * and refreshes the router; it does not grant access to anything by
 * itself (see active-organization.ts).
 */
export function OrganizationProvider({
  organizations,
  activeOrganizationId,
  children,
}: OrganizationProviderProps) {
  const router = useRouter();
  const [isSwitching, startTransition] = useTransition();

  const activeOrganization = useMemo(
    () => organizations.find((org) => org.id === activeOrganizationId) ?? organizations[0] ?? null,
    [organizations, activeOrganizationId],
  );

  const value = useMemo<OrganizationContextValue>(
    () => ({
      organizations,
      activeOrganization,
      isSwitching,
      setActiveOrganizationId: (organizationId: string) => {
        const formData = new FormData();
        formData.set("organizationId", organizationId);
        startTransition(async () => {
          await setActiveOrganizationAction(formData);
          router.refresh();
        });
      },
    }),
    [organizations, activeOrganization, isSwitching, router],
  );

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}

export function useActiveOrganization(): OrganizationContextValue {
  const context = useContext(OrganizationContext);
  if (!context) {
    throw new Error("useActiveOrganization must be used within an OrganizationProvider");
  }
  return context;
}
