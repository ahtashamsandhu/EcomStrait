"use client";

import Image, { type ImageProps } from "next/image";
import { useState } from "react";

/**
 * `next/image` for media-library uploads (blog covers today), with one
 * safety net: if the image optimizer rejects the URL — a host missing from
 * `images.remotePatterns` in whatever build is live, a transient optimizer
 * error — the browser fires `onError` on the `<img>`, and this re-renders
 * the same URL `unoptimized`, i.e. straight from the CDN. A slightly larger
 * download beats a broken-image icon on a live storefront.
 *
 * Why not `unoptimized` always: the optimizer's resizing/WebP is worth
 * keeping for the common case; this only pays the cost when the optimized
 * path has actually failed for this one image.
 */
export function CoverImage({ alt, ...props }: Omit<ImageProps, "onError">) {
  const [fallback, setFallback] = useState(false);
  return (
    <Image
      {...props}
      alt={alt}
      unoptimized={fallback || props.unoptimized}
      onError={() => {
        if (!fallback) setFallback(true);
      }}
    />
  );
}
