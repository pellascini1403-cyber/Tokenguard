interface MissingBackendCapabilityProps {
  title: string;
  explanation: string;
}

/**
 * Renders when a page's data depends on a backend endpoint that does not
 * exist yet. This is not a loading or error state — it's an honest
 * statement of a real, current gap, per the frontend README's "Missing
 * backend capabilities" section. Never replaced with mock/sample data.
 *
 * Dark card on purpose: this renders inside the dashboard's white body
 * zone (see AppScreen), where the design spec calls for black cards
 * rather than white ones sitting on white.
 */
export function MissingBackendCapability({ title, explanation }: MissingBackendCapabilityProps) {
  return (
    <div className="rounded-lg bg-black px-6 py-8">
      <p className="text-sm font-medium text-amber-400">{title}</p>
      <p className="mt-2 max-w-2xl text-sm text-zinc-300">{explanation}</p>
    </div>
  );
}
