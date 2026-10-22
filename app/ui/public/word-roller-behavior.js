import { Lifetime } from "./lifetime.ts";
import { typographyReady } from "./typography.ts";
// Vanilla behavior, with resources owned by the component AbortSignal.
export function mount(signal) {
  const scope = new Lifetime(signal);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  /* ---------- Word roller ---------- */
  const roller = document.querySelector(".roller");
  if (roller) {
    const rollTrack = roller.querySelector(".roller-track");
    const words = [...rollTrack.children];
    let index = 0;
    let fontsReady = false;
    let interval;
    const pad = () => parseFloat(getComputedStyle(roller).paddingLeft) * 2;
    const fit = () => {
      if (!fontsReady || reduceMotion.matches) return;
      roller.style.width = `${words[index].offsetWidth + pad()}px`;
    };
    typographyReady().then(scope.guard(() => { fontsReady = true; syncMotion(); }));
    scope.listen(document.fonts, "loadingdone", fit);
    const syncMotion = () => {
      if (interval) { window.clearInterval(interval); scope.intervals.delete(interval); interval = 0; }
      index = 0;
      rollTrack.style.removeProperty("transform");
      roller.classList.toggle("is-js", !reduceMotion.matches);
      if (!fontsReady || reduceMotion.matches) { roller.style.removeProperty("width"); return; }
      fit();
      interval = scope.setInterval(() => {
        if (document.hidden) return;
        index = (index + 1) % (words.length - 1);
        // Measure width before writing transforms.
        const width = words[index].offsetWidth + pad();
        rollTrack.style.transform = `translateY(${-index * 1.25}em)`;
        roller.style.width = `${width}px`;
      }, 2400);
    };
    scope.listen(reduceMotion, "change", syncMotion);
    syncMotion();
  }

  scope.cleanup(() => {
    roller?.classList.remove("is-js");
    roller?.style.removeProperty("width");
    roller?.querySelector(".roller-track")?.style.removeProperty("transform");
  });
}
