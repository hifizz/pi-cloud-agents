import { useState } from "react";
import { cx } from "../../../lib/cx";
import type { ImagePart } from "../../../types";

const src = (img: ImagePart) => `data:${img.mimeType};base64,${img.data}`;

/** Clickable thumbnails that open a full-size lightbox. */
export function ImageStrip({ images, size = "sm", alt = "Tool result" }: { images: ImagePart[]; size?: "sm" | "lg"; alt?: string }) {
  const [zoom, setZoom] = useState<string>();
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {images.map((img, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setZoom(src(img))}
            aria-label="Enlarge image"
            className="overflow-hidden rounded-lg border border-zinc-800 transition-colors hover:border-zinc-600 focus-visible:outline-2 focus-visible:outline-sky-400"
          >
            <img src={src(img)} alt={`${alt} thumbnail`} className={cx("w-auto object-cover", size === "lg" ? "max-h-56" : "h-20")} />
          </button>
        ))}
      </div>
      {zoom && <Lightbox src={zoom} alt={`${alt} full size`} onClose={() => setZoom(undefined)} />}
    </>
  );
}

export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <img src={src} alt={alt} className="max-h-full max-w-full rounded-lg shadow-2xl" />
      <button
        type="button"
        autoFocus
        onClick={onClose}
        className="absolute right-4 top-4 rounded-md bg-zinc-800 px-3 py-1 text-sm text-zinc-100 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-400"
      >
        Close
      </button>
    </div>
  );
}
