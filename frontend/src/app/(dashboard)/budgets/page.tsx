import { requireServerSession } from "@/lib/auth/session";
import { listOrganizations } from "@/lib/api/organizations";
import { AppScreen } from "@/components/dashboard/app-screen";
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
    <AppScreen header={<h1 className="text-xl font-semibold">Budgets</h1>}>
      <ul className="divide-y divide-zinc-800 overflow-hidden rounded-lg bg-black">
        {organizations.map((org) => (
          <li key={org.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="font-medium text-white">{org.name}</span>
            <span className="text-zinc-400">Monthly budget: ${org.monthlyBudgetUsd}</span>
          </li>
        ))}
      </ul>
      <MissingBackendCapability
        title="No current-spend or budget-edit endpoint exists yet"
        explanation="The backend enforces this budget on every proxy request (BudgetService), but does not expose current period spend, remaining budget, or an endpoint to change the budget value over HTTP. This page will show real spend-vs-budget data and an edit form once those endpoints exist."
      />
    </AppScreen>
  );
}
