import type { Handle } from "remix/component";

export function Marquee(handle: Handle<{ names: string[] }>) {
  return () => (
    <span class="marquee" aria-hidden="true">
      <span class="marquee-track">
        {[...handle.props.names, ...handle.props.names].map((name, i) => (
          <span key={i} class={i % handle.props.names.length % 3 === 1 ? "marquee-outline" : undefined}>{name}</span>
        ))}
      </span>
    </span>
  );
}
