import { Lifetime } from "./lifetime.ts";

// Native details owns state. Modern engines animate ::details-content in CSS;
// older engines get the same reversible transition using a measured height.
export function enhanceArchive(details, signal) {
  if (CSS.supports("interpolate-size: allow-keywords") && CSS.supports("selector(details::details-content)")) return;
  const scope = new Lifetime(signal);
  const summary = details.querySelector("summary");
  const content = details.querySelector(".archive-content");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let expanded = details.open;
  let moving = false;
  details.dataset.enhanced = "";
  details.dataset.expanded = String(expanded);
  content.style.height = expanded ? "auto" : "0px";

  function finish() {
    moving = false;
    details.open = expanded;
    content.style.height = expanded ? "auto" : "0px";
  }
  scope.listen(summary, "click", (event) => {
    event.preventDefault();
    const height = content.getBoundingClientRect().height;
    expanded = !expanded;
    if (!expanded && content.contains(document.activeElement)) summary.focus({ preventScroll: true });
    details.open = true;
    details.dataset.expanded = String(expanded);
    summary.setAttribute("aria-expanded", String(expanded));
    content.inert = !expanded;
    content.style.height = `${height}px`;
    // Commit the current visual size before changing its target, even mid-transition.
    void content.offsetHeight;
    moving = true;
    content.style.height = `${expanded ? content.scrollHeight : 0}px`;
    if (reduceMotion.matches || Math.abs(height - (expanded ? content.scrollHeight : 0)) < 1) finish();
  });
  scope.listen(content, "transitionend", (event) => {
    if (event.target === content && event.propertyName === "height") finish();
  });
  scope.listen(reduceMotion, "change", () => { if (moving) finish(); });
  const resize = new ResizeObserver(() => {
    if (moving && expanded) content.style.height = `${content.firstElementChild.scrollHeight}px`;
  });
  resize.observe(content.firstElementChild);
  scope.cleanup(() => {
    resize.disconnect();
    details.open = expanded;
    delete details.dataset.enhanced;
    delete details.dataset.expanded;
    content.style.removeProperty("height");
    content.inert = false;
    summary.removeAttribute("aria-expanded");
  });
}
