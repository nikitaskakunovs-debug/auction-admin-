"use client";

import { useState } from "react";
import { photoThumb } from "@/lib/photos";

/** Lot-page gallery: main image + clickable thumbnail strip. */
export function PhotoGallery({ photos, alt }: { photos: string[]; alt: string }) {
  const [idx, setIdx] = useState(0);
  if (photos.length === 0) return null;
  const current = photos[Math.min(idx, photos.length - 1)]!;
  return (
    <div style={{ display: "grid", gap: 8, maxWidth: 640 }}>
      <div style={{ background: "#F2F1EE", borderRadius: 14, overflow: "hidden", border: "1px solid rgba(10,10,10,0.08)" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={current} alt={alt} style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "contain", display: "block" }} />
      </div>
      {photos.length > 1 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {photos.map((p, i) => (
            <button
              key={p}
              onClick={() => setIdx(i)}
              aria-label={`Photo ${i + 1}`}
              style={{
                all: "unset",
                cursor: "pointer",
                borderRadius: 8,
                overflow: "hidden",
                border: i === idx ? "2px solid #0A0A0A" : "1px solid rgba(10,10,10,0.15)",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoThumb(p)} alt="" style={{ width: 64, height: 64, objectFit: "cover", display: "block" }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
