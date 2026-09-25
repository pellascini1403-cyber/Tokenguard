"use client";

import { useEffect } from "react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="px-4 py-6">
      <p className="text-sm font-medium text-red-700">Something went wrong loading this page.</p>
      <button
        type="button"
        onClick={reset}
        className="mt-3 rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
      >
        Try again
      </button>
    </div>
  );
}
