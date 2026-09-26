import Image from "next/image";
import type { ReactNode } from "react";

interface AssetCardProps {
  src: string;
  width: number;
  height: number;
  children: ReactNode;
  className?: string;
}

/**
 * Renders one of the 5 provided card-shape PNGs (public/assets/overview/)
 * as the card's background, with real React content laid on top — never
 * baked into a redrawn image. `width`/`height` are the PNG's own crop
 * dimensions, used only to fix the aspect ratio; actual rendered size is
 * responsive.
 */
export function AssetCard({ src, width, height, children, className }: AssetCardProps) {
  return (
    <div className={`relative w-full ${className ?? ""}`} style={{ aspectRatio: `${width} / ${height}` }}>
      <Image src={src} alt="" aria-hidden="true" fill className="object-contain" />
      <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
        {children}
      </div>
    </div>
  );
}
