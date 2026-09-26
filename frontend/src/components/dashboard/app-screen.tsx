import type { ReactNode } from "react";

interface AppScreenProps {
  header: ReactNode;
  children: ReactNode;
}

/**
 * The two-zone screen structure from the reference phone mockup: a black
 * header zone at the top, a white body zone below. Per the design spec,
 * anything placed in the white zone must use dark/black card styling for
 * contrast (see MissingBackendCapability/EmptyState) — this component
 * only provides the two zones, it doesn't enforce that on its children.
 */
export function AppScreen({ header, children }: AppScreenProps) {
  return (
    <div className="flex min-h-full flex-col">
      <div className="bg-black px-4 pb-6 pt-8 text-white">{header}</div>
      <div className="flex-1 space-y-6 bg-white px-4 py-6">{children}</div>
    </div>
  );
}
