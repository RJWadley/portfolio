import type { Handle } from "remix/component";

// The Latin font has no arrows. Keep these small icons independent of font fallback.
export function Arrow(handle: Handle<{ direction?: "right" | "down" }>) {
  return () => (
    <svg class="icon-arrow" data-direction={handle.props.direction} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 13 13 3M3 3h10v10" />
    </svg>
  );
}
