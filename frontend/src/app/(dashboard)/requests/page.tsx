import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";

/**
 * Same gap as /usage: token_logs rows exist and UsageService can query
 * them, but there is no GET /v1/organizations/:organizationId/requests
 * (or similar) route. Also note the privacy model this page must respect
 * once such a route exists: TokenGuard never persists request/response
 * bodies (see backend README's privacy notes), so a future requests list
 * can only ever show metadata (model, tokens, cost, status, timestamp) —
 * never prompts or completions.
 */
export default function RequestsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">Requests</h1>
      <MissingBackendCapability
        title="No request-log-read endpoint exists yet"
        explanation="The backend stores per-request metadata in token_logs (model, tokens, cost, status, timestamp — never prompts or responses) but has not exposed a route to list or fetch it. This page will list real request metadata once that endpoint exists."
      />
    </div>
  );
}
