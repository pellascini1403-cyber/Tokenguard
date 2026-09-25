interface MissingBackendCapabilityProps {
  title: string;
  explanation: string;
}

/**
 * Renders when a page's data depends on a backend endpoint that does not
 * exist yet. This is not a loading or error state — it's an honest
 * statement of a real, current gap, per the frontend README's "Missing
 * backend capabilities" section. Never replaced with mock/sample data.
 */
export function MissingBackendCapability({ title, explanation }: MissingBackendCapabilityProps) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-6 py-8">
      <p className="text-sm font-medium text-amber-900">{title}</p>
      <p className="mt-2 max-w-2xl text-sm text-amber-800">{explanation}</p>
    </div>
  );
}
