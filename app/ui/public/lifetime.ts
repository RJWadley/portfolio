/** Own every imperative resource with the component/ref AbortSignal. */
export class Lifetime {
  readonly frames = new Set<number>();
  readonly timers = new Set<number>();
  readonly intervals = new Set<number>();
  private cleanups: (() => void)[] = [];
  constructor(readonly signal: AbortSignal) {
    signal.addEventListener(
      "abort",
      () => {
        for (const frame of this.frames) window.cancelAnimationFrame(frame);
        for (const timer of this.timers) window.clearTimeout(timer);
        for (const timer of this.intervals) window.clearInterval(timer);
        this.frames.clear();
        this.timers.clear();
        this.intervals.clear();
        for (const cleanup of this.cleanups.reverse()) cleanup();
      },
      { once: true },
    );
  }
  cleanup(callback: () => void) {
    this.cleanups.push(callback);
  }
  guard<T extends unknown[]>(callback: (...args: T) => unknown) {
    return (...args: T) => {
      if (!this.signal.aborted) return callback(...args);
    };
  }
  listen(
    target: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject,
    options: boolean | AddEventListenerOptions = {},
  ) {
    target.addEventListener(type, callback, {
      ...(typeof options === "boolean" ? { capture: options } : options),
      signal: this.signal,
    });
  }
  requestAnimationFrame = (callback: FrameRequestCallback): number => {
    if (this.signal.aborted) return 0;
    const id = window.requestAnimationFrame((now) => {
      this.frames.delete(id);
      if (!this.signal.aborted) callback(now);
    });
    this.frames.add(id);
    return id;
  };
  cancelAnimationFrame = (id: number) => {
    window.cancelAnimationFrame(id);
    this.frames.delete(id);
  };
  setTimeout = (callback: () => void, delay: number) => {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.signal.aborted) callback();
    }, delay);
    this.timers.add(id);
    return id;
  };
  clearTimeout = (id: number | undefined) => {
    window.clearTimeout(id);
    this.timers.delete(id!);
  };
  setInterval = (callback: () => void, delay: number) => {
    const id = window.setInterval(this.guard(callback), delay);
    this.intervals.add(id);
    return id;
  };
}
