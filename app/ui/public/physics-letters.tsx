import { clientEntry, ref, type Handle } from "remix/component";
import { mountPhysics } from "./physics.js";

type Physics = ReturnType<typeof mountPhysics>;
interface LetterPose {
  el: HTMLElement;
  body: { position: { x: number; y: number } };
  hx: number;
  hy: number;
}
interface PhysicsVerification {
  physics: () => { engines: number; mounts: number; disposals: number; frames: number; bodies: number[] };
  letters: () => { char: string | null; x: number; y: number; hx: number; hy: number }[] | undefined;
  remountPhysics: () => Promise<void>;
}
declare global {
  interface Window {
    __portfolioPhysics?: Physics;
    __portfolioVerify?: PhysicsVerification;
  }
  interface WindowEventMap {
    "portfolio:physics": CustomEvent<Physics | null>;
  }
}

// This anchor owns one engine shared by hero letters, footer letters, and cursor ball.
export const PhysicsLetters = clientEntry(
  import.meta.url,
  function PhysicsLetters(handle: Handle) {
    let mounted = true;
    const live = new Set<ReturnType<typeof mountPhysics>>();
    let mounts = 0,
      disposals = 0;
    handle.queueTask(() => {
      if (new URLSearchParams(location.search).has("verify")) {
        window.__portfolioVerify = {
          physics: () => ({
            engines: live.size,
            mounts,
            disposals,
            frames: [...live].reduce((sum, p) => sum + p.scope.frames.size, 0),
            bodies: [...live].map((p) => p.letters().length),
          }),
          letters: () =>
            [...live][0]
              ?.letters()
              .map((l: LetterPose) => ({
                char: l.el.textContent,
                x: l.body.position.x,
                y: l.body.position.y,
                hx: l.hx,
                hy: l.hy,
              })),
          remountPhysics: async () => {
            mounted = false;
            await handle.update();
            mounted = true;
            await handle.update();
          },
        };
      }
    });
    return () =>
      mounted ? (
        <div
          class="cursor-ball"
          aria-hidden="true"
          mix={ref((_node, signal) => {
            const lifetime = AbortSignal.any([signal, handle.signal]);
            const physics = mountPhysics(lifetime);
            live.add(physics);
            mounts++;
            // Accessible to the independently mounted debug entry without duplicating an engine.
            window.dispatchEvent(
              new CustomEvent("portfolio:physics", { detail: physics }),
            );
            window.__portfolioPhysics = physics;
            lifetime.addEventListener(
              "abort",
              () => {
                live.delete(physics);
                disposals++;
                if (window.__portfolioPhysics === physics)
                  delete window.__portfolioPhysics;
                window.dispatchEvent(
                  new CustomEvent("portfolio:physics", { detail: null }),
                );
              },
              { once: true },
            );
          })}
        />
      ) : null;
  },
);
