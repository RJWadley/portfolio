import { clientEntry, type Handle } from "remix/component";
import { mount } from "./word-roller-behavior.js";
export const WordRoller = clientEntry(
  import.meta.url,
  function WordRoller(handle: Handle) {
    handle.queueTask(() => mount(handle.signal));
    return () => (
      <span class="roller" aria-hidden="true">
        <span class="roller-track">
          {["websites", "apps", "dev tools", "interfaces", "websites"].map(
            (word, i) => (
              <span key={i}>{word}</span>
            ),
          )}
        </span>
      </span>
    );
  },
);
