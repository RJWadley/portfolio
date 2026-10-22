import { Lifetime } from "./lifetime.ts";
// Vanilla behavior, with resources owned by the component AbortSignal.
export function mount(signal) {
  const scope = new Lifetime(signal);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  /* ---------- Reveals + media ---------- */
  const revealTargets = document.querySelectorAll(
    ".section-head, .konn3kt, .oss li, .about-lead, .timeline li, .play-card, .archive",
  );
  revealTargets.forEach((el) => el.classList.add("reveal"));
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px" },
  );
  revealTargets.forEach((el) => io.observe(el));

  const canPlay = () =>
    !reduceMotion.matches && !navigator.connection?.saveData;
  const visibleVideos = new Set();
  function syncVideo(video, visible) {
    if (visible && canPlay()) {
      if (!video.src) video.src = video.dataset.src;
      video.play().then(scope.guard(() => {
        if (canPlay() && visibleVideos.has(video)) video.classList.add("is-playing");
        else video.pause();
      })).catch(() => {});
    } else {
      video.pause();
      video.classList.remove("is-playing");
    }
  }
  const videoIO = new IntersectionObserver(
    (entries) => {
      for (const { target: video, isIntersecting } of entries) {
        if (isIntersecting) visibleVideos.add(video);
        else visibleVideos.delete(video);
        syncVideo(video, isIntersecting);
      }
    },
    { threshold: 0.35 },
  );
  document
    .querySelectorAll(".card-media video")
    .forEach((v) => videoIO.observe(v));
  scope.listen(reduceMotion, "change", () => {
    for (const video of visibleVideos) syncVideo(video, true);
  });

  scope.cleanup(() => {
    io.disconnect();
    videoIO.disconnect();
    visibleVideos.clear();
    document.querySelectorAll(".card-media video").forEach((v) => {
      v.pause();
      v.classList.remove("is-playing");
    });
    revealTargets.forEach((el) => el.classList.remove("reveal", "is-in"));

  });
}
