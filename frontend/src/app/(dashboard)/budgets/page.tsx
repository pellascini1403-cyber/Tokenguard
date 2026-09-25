import { requireServerSession } from "@/lib/auth/session";
import { listOrganizations } from "@/lib/api/organizations";
import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";

/**
 * The backend enforces monthly budgets (organizations.monthly_budget_usd,
 * checked/committed by BudgetService — see backend README's "Budget
 * enforcement" section) but has no HTTP route to read current spend
 * against that budget, nor one to edit it. The only budget-related field
 * reachable over HTTP today is the static monthlyBudgetUsd already
 * returned by GET /v1/organizations, shown below.
 */
export default async function BudgetsPage() {
  const session = await requireServerSession();
  const organizations = await listOrganizations(session.accessToken);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">Budgets</h1>
      <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200">
        {organizations.map((org) => (
          <li key={org.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="font-medium text-zinc-900">{org.name}</span>
            <span className="text-zinc-500">Monthly budget: ${org.monthlyBudgetUsd}</span>
          </li>
        ))}
      </ul>
      <MissingBackendCapability
        title="No current-spend or budget-edit endpoint exists yet"
        explanation="The backend enforces this budget on every proxy request (BudgetService), but does not expose current period spend, remaining budget, or an endpoint to change the budget value over HTTP. This page will show real spend-vs-budget data and an edit form once those endpoints exist."
      />
    </div>
  );
}
