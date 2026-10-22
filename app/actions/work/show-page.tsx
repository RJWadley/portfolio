import { Arrow } from "../../ui/arrow.tsx";
import { Document } from "../../ui/document.tsx";
import { Header, Footer } from "../../ui/sections.tsx";
import { routes } from "../../routes.ts";
import { HangingSign } from "../../ui/public/hanging-sign.tsx";
import { PhysicsLetters } from "../../ui/public/physics-letters.tsx";
import { DebugOverlay } from "../../ui/public/debug-overlay.tsx";
export function CaseStudy() {
  return () => (
    <Document
      title="New Form Capital — Robbie Wadley"
      description="A full case study is coming soon. I built this venture capital site with Reform Collective."
      path={routes.work.show.href({ slug: "new-form" })}
    >
      <a class="skip-link" href="#case-study">
        Skip to case study
      </a>
      <Header home={false} />
      <HangingSign />
      <main>
        <section class="hero" id="case-study">
          <p class="hero-label mono">Selected work · 2022</p>
          <div class="section-head">
            <p class="mono">Case study</p>
            <h1>New Form Capital</h1>
            <p class="section-note">
              A full case study is coming soon. I built this
              venture capital site with Reform Collective.
            </p>
          </div>
          <div class="hero-foot">
            <a
              class="pill"
              href="https://www.reformcollective.com/newform"
              target="_blank"
              rel="noopener"
            >
              See the project <span aria-hidden="true"><Arrow /></span>
            </a>
            <a href={routes.home.href() + "#work"}>Back to selected work</a>
          </div>
        </section>
      </main>
      <Footer />
      <PhysicsLetters />
      <DebugOverlay />
    </Document>
  );
}
