"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Attach the returned ref to whatever wraps a dropdown/menu/popover panel
 * (its trigger button included, so the toggle click isn't itself seen as
 * "outside") — while `active` is true, a pointer press anywhere outside that
 * element calls `onOutside`, closing it the way every native menu does.
 *
 * `mousedown`/`touchstart`, not `click`: closing on press-down means the
 * panel is already gone by the time a `click` on whatever's underneath would
 * fire, so that click can act on its own target immediately (open a
 * different dropdown, follow a link) instead of the first outside click
 * being "swallowed" just closing this one.
 *
 * `onOutside` is read through a ref rather than listed as an effect
 * dependency — callers pass an inline closure (`() => setOpen(false)`) that
 * would otherwise be a new function every render, tearing the listener down
 * and rebuilding it on every render the panel is open for no reason. Only
 * `active` flipping actually needs to add/remove the listener.
 */
export function useClickOutside<T extends HTMLElement>(active: boolean, onOutside: () => void): RefObject<T | null> {
  const ref = useRef<T>(null);
  const onOutsideRef = useRef(onOutside);
  onOutsideRef.current = onOutside;

  useEffect(() => {
    if (!active) return;
    function handlePointerDown(e: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutsideRef.current();
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [active]);

  return ref;
}
