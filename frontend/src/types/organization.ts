/**
 * Mirrors backend/src/routes/v1/organizations.route.ts's
 * serializeOrganization() exactly. The backend does NOT return the
 * caller's role in this organization (see organizations.service.ts:
 * requireRole() is enforced server-side only and never surfaced to a
 * response body) — do not add a `role` field here. See the frontend
 * README's "Missing backend capabilities" section.
 */
export interface Organization {
  id: string;
  name: string;
  /** Decimal string, e.g. "100.00" — never null, mirrors the DB column. */
  monthlyBudgetUsd: string;
  createdAt: string;
  updatedAt: string;
}
