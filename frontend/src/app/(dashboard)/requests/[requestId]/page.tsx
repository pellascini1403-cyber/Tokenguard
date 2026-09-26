import { AppScreen } from "@/components/dashboard/app-screen";
import { MissingBackendCapability } from "@/components/ui/missing-backend-capability";

export default async function RequestDetailPage(props: PageProps<"/requests/[requestId]">) {
  const { requestId } = await props.params;

  return (
    <AppScreen header={<h1 className="text-xl font-semibold">Request {requestId}</h1>}>
      <MissingBackendCapability
        title="No single-request-read endpoint exists yet"
        explanation="There is no GET /v1/organizations/:organizationId/requests/:requestId route, so this page cannot look up a request by id. Per TokenGuard's privacy model, such an endpoint would only ever be able to return metadata (model, tokens, cost, status, timestamp) — prompts and responses are never persisted."
      />
    </AppScreen>
  );
}
