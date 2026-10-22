import { Lifetime } from "./lifetime.ts";
// Vanilla behavior, with resources owned by the component AbortSignal.
export function mount(signal) {
  const scope = new Lifetime(signal);
  const {
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout,
    clearTimeout,
    setInterval,
  } = scope;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = matchMedia("(pointer: fine)");
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const pointer = { x: -1e4, y: -1e4 };
  scope.listen(
    window,
    "pointermove",
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    },
    { passive: true },
  );
  scope.listen(document.documentElement, "pointerleave", () => {
    pointer.x = pointer.y = -1e4;
  });
  /* ---------- Cursor label + media parallax ---------- */
  const cursor = document.querySelector(".cursor");
  const label = cursor?.querySelector("span");
  let cx = -100,
    cy = -100,
    cursorFrame = 0;
  function moveCursor() {
    cx += (pointer.x - cx) * 0.22;
    cy += (pointer.y - cy) * 0.22;
    cursor.style.setProperty("--cx", `${cx}px`);
    cursor.style.setProperty("--cy", `${cy}px`);
    cursorFrame =
      cursor.classList.contains("is-on") ||
      Math.hypot(pointer.x - cx, pointer.y - cy) > 0.5
        ? requestAnimationFrame(moveCursor)
        : 0;
  }
  document.querySelectorAll(".card-media").forEach((media) => {
    scope.listen(media, "pointerenter", (e) => {
      if (!finePointer.matches) return;
      label.textContent = media.closest(".card").dataset.cursor;
      if (!cursor.classList.contains("is-on")) {
        cx = e.clientX;
        cy = e.clientY;
      }
      cursor.classList.add("is-on");
      if (!cursorFrame) cursorFrame = requestAnimationFrame(moveCursor);
    });
    scope.listen(media, "pointermove", (e) => {
      if (reduceMotion.matches) return;
      const r = media.getBoundingClientRect();
      media.style.setProperty(
        "--mx",
        `${((e.clientX - r.left) / r.width - 0.5) * -14}px`,
      );
      media.style.setProperty(
        "--my",
        `${((e.clientY - r.top) / r.height - 0.5) * -14}px`,
      );
    });
    scope.listen(media, "pointerleave", () => {
      cursor.classList.remove("is-on");
      media.style.setProperty("--mx", "0px");
      media.style.setProperty("--my", "0px");
    });
  });

  scope.cleanup(() => cursor?.classList.remove("is-on"));
}
