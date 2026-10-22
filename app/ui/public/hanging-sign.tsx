import { clientEntry, type Handle } from "remix/component";
import { mount } from "./hanging-sign-behavior.js";
import { SignMarkup } from "./sign-markup.tsx";
export const HangingSign = clientEntry(
  import.meta.url,
  function HangingSign(handle: Handle) {
    handle.queueTask(() => mount(handle.signal));
    return () => <SignMarkup />;
  },
);
