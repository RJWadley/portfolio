import { clientEntry, type Handle } from "remix/component";
import { mount } from "./cursor-label-behavior.js";
export const CursorLabel = clientEntry(
  import.meta.url,
  function CursorLabel(handle: Handle) {
    handle.queueTask(() => mount(handle.signal));
    return () => (
      <div class="cursor" aria-hidden="true">
        <span></span>
      </div>
    );
  },
);
