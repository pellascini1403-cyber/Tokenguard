import { AppScreen } from "@/components/dashboard/app-screen";

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
    <AppScreen header={<h1 className="text-xl font-semibold">API reference</h1>}>
      <div className="overflow-x-auto rounded-lg bg-black">
        <table className="w-full text-left text-sm">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-4 py-2 font-medium">Method</th>
              <th className="px-4 py-2 font-medium">Path</th>
              <th className="px-4 py-2 font-medium">Auth</th>
              <th className="px-4 py-2 font-medium">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {ENDPOINTS.map((endpoint) => (
              <tr key={`${endpoint.method}-${endpoint.path}`}>
                <td className="px-4 py-2 font-mono text-xs text-white">{endpoint.method}</td>
                <td className="px-4 py-2 font-mono text-xs text-white">{endpoint.path}</td>
                <td className="px-4 py-2 text-zinc-400">{endpoint.auth}</td>
                <td className="px-4 py-2 text-zinc-400">{endpoint.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppScreen>
  );
}
