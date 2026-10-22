import { clientEntry, type Handle } from "remix/component";
import type { mountPhysics } from "./physics.js";
import type { mount as mountSign } from "./hanging-sign-behavior.js";

declare global {
  interface Window {
    __portfolioSign?: ReturnType<typeof mountSign>;
  }
}
export const DebugOverlay = clientEntry(
  import.meta.url,
  function DebugOverlay(handle: Handle) {
    let controller: AbortController | undefined;
    handle.queueTask(async () => {
      if (!new URLSearchParams(location.search).has("debug")) return;
      const { physicsDebug } = await import("./physics-debug.js");
      if (handle.signal.aborted) return;
      const attach = (physics: ReturnType<typeof mountPhysics> | null | undefined) => {
        controller?.abort();
        if (!physics) return;
        controller = new AbortController();
        physicsDebug(
          { ...physics, sign: () => window.__portfolioSign?.() },
          AbortSignal.any([controller.signal, handle.signal]),
        );
      };
      window.addEventListener(
        "portfolio:physics",
        (event) => attach(event.detail),
        { signal: handle.signal },
      );
      attach(window.__portfolioPhysics);
    });
    return () => <template data-debug-overlay="" />;
  },
);
