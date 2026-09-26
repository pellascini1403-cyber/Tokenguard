import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

/**
 * A real empty state — used when a backend call succeeded and genuinely
 * returned no data. Never used to paper over a missing endpoint; see
 * MissingBackendCapability for that case.
 *
 * Dark card on purpose: renders inside the dashboard's white body zone
 * (see AppScreen), where the design spec calls for black cards.
 */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg bg-black px-6 py-10 text-center">
      <p className="text-sm font-medium text-white">{title}</p>
      <p className="max-w-sm text-sm text-zinc-400">{description}</p>
      {action}
    </div>
  );
}
