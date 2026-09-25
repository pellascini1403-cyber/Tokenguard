import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OrganizationProvider, useActiveOrganization } from "@/lib/organizations/context";
import type { Organization } from "@/types/organization";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const setActiveOrganizationActionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/organizations/active-organization", () => ({
  setActiveOrganizationAction: (formData: FormData) => setActiveOrganizationActionMock(formData),
}));

const organizations: Organization[] = [
  { id: "org-1", name: "Acme", monthlyBudgetUsd: "100.00", createdAt: "t", updatedAt: "t" },
  { id: "org-2", name: "Globex", monthlyBudgetUsd: "50.00", createdAt: "t", updatedAt: "t" },
];

function Probe() {
  const { activeOrganization, organizations: orgs, setActiveOrganizationId } = useActiveOrganization();
  return (
    <div>
      <p data-testid="active-name">{activeOrganization?.name ?? "none"}</p>
      <p data-testid="count">{orgs.length}</p>
      <button onClick={() => setActiveOrganizationId("org-2")}>switch</button>
    </div>
  );
}

describe("OrganizationProvider / useActiveOrganization", () => {
  it("throws when used outside a provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(
      "useActiveOrganization must be used within an OrganizationProvider",
    );
    consoleError.mockRestore();
  });

  it("resolves the active organization from the given id", () => {
    render(
      <OrganizationProvider organizations={organizations} activeOrganizationId="org-2">
        <Probe />
      </OrganizationProvider>,
    );
    expect(screen.getByTestId("active-name").textContent).toBe("Globex");
    expect(screen.getByTestId("count").textContent).toBe("2");
  });

  it("falls back to the first organization when the active id doesn't match any", () => {
    render(
      <OrganizationProvider organizations={organizations} activeOrganizationId="does-not-exist">
        <Probe />
      </OrganizationProvider>,
    );
    expect(screen.getByTestId("active-name").textContent).toBe("Acme");
  });

  it("switching writes the cookie via the server action and refreshes the router", async () => {
    render(
      <OrganizationProvider organizations={organizations} activeOrganizationId="org-1">
        <Probe />
      </OrganizationProvider>,
    );

    fireEvent.click(screen.getByText("switch"));

    await waitFor(() => expect(setActiveOrganizationActionMock).toHaveBeenCalledTimes(1));
    const sentFormData = setActiveOrganizationActionMock.mock.calls[0][0] as FormData;
    expect(sentFormData.get("organizationId")).toBe("org-2");
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });
});
