import { clientEntry, type Handle } from "remix/component";
import { mount } from "./scroll-effects-behavior.js";
export const ScrollEffects = clientEntry(
  import.meta.url,
  function ScrollEffects(handle: Handle) {
    handle.queueTask(() => mount(handle.signal));
    return () => <template data-scroll-effects="" />;
  },
);
