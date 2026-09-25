import { TokenGuardApiError, TokenGuardNetworkError } from "@/types/api-error";

interface ApiErrorMessageProps {
  error: unknown;
}

/**
 * Renders a caught API error using only fields TokenGuardApiError /
 * TokenGuardNetworkError actually carry — never a generic "Something
 * went wrong" that hides which backend error code fired.
 */
export function ApiErrorMessage({ error }: ApiErrorMessageProps) {
  if (error instanceof TokenGuardApiError) {
    return (
      <div role="alert" className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
        <p className="font-medium">{error.code}</p>
        <p>{error.message}</p>
        {error.retryAfterSeconds !== undefined && (
          <p className="mt-1 text-red-600">Retry after {error.retryAfterSeconds}s.</p>
        )}
      </div>
    );
  }

  if (error instanceof TokenGuardNetworkError) {
    return (
      <div role="alert" className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
        <p className="font-medium">Network error</p>
        <p>{error.message}</p>
      </div>
    );
  }

  return (
    <div role="alert" className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
      <p>An unexpected error occurred.</p>
    </div>
  );
}
