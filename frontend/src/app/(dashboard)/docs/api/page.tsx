/**
 * Mirrors exactly what backend/README.md documents under "AI proxy" and
 * "Endpoints" — no endpoint is listed here that the backend doesn't
 * actually implement.
 */
const ENDPOINTS = [
  { method: "GET", path: "/health", auth: "None", description: "Service health check." },
  { method: "GET", path: "/v1/me", auth: "Supabase user", description: "The signed-in user." },
  {
    method: "POST",
    path: "/v1/organizations",
    auth: "Supabase user",
    description: "Create an organization (caller becomes owner).",
  },
  {
    method: "GET",
    path: "/v1/organizations",
    auth: "Supabase user",
    description: "List organizations the caller belongs to.",
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/keys",
    auth: "Supabase user, owner role",
    description: "Create a TokenGuard API key (plaintext returned once).",
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/keys/:keyId/revoke",
    auth: "Supabase user, owner role",
    description: "Revoke a TokenGuard API key.",
  },
  {
    method: "POST",
    path: "/v1/chat/completions",
    auth: "TokenGuard API key",
    description: "OpenAI-compatible proxy endpoint.",
  },
  {
    method: "POST",
    path: "/v1/messages",
    auth: "TokenGuard API key",
    description: "Anthropic-compatible proxy endpoint.",
  },
];

export default function ApiDocsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900">API reference</h1>
      <div className="overflow-x-auto rounded-lg border border-zinc-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-zinc-500">
            <tr>
              <th className="px-4 py-2 font-medium">Method</th>
              <th className="px-4 py-2 font-medium">Path</th>
              <th className="px-4 py-2 font-medium">Auth</th>
              <th className="px-4 py-2 font-medium">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200">
            {ENDPOINTS.map((endpoint) => (
              <tr key={`${endpoint.method}-${endpoint.path}`}>
                <td className="px-4 py-2 font-mono text-xs">{endpoint.method}</td>
                <td className="px-4 py-2 font-mono text-xs">{endpoint.path}</td>
                <td className="px-4 py-2 text-zinc-600">{endpoint.auth}</td>
                <td className="px-4 py-2 text-zinc-600">{endpoint.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
