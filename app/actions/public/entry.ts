import { run } from "remix/component";

// Preserve the vanilla site's document/hash navigation. Every static document has its own
// complete initial import map; it never needs a server to resolve a frame or another map.
window.navigation?.addEventListener("navigate", (event) =>
  event.stopImmediatePropagation(),
);
const app = run({
  async loadModule(url, name) {
    const module = await import(url);
    if (typeof module[name] !== "function")
      throw new Error(`Unknown component: ${url}#${name}`);
    return module[name];
  },
});
app.addEventListener("error", (event) =>
  console.error("Component error:", event.error),
);
await app.ready();
document.documentElement.dataset.hydrated = "true";
