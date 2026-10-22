import { Arrow } from "../ui/arrow.tsx";
import { Document } from "../ui/document.tsx";
import { Header } from "../ui/sections.tsx";
import { routes } from "../routes.ts";

export function NotFoundPage() {
  return () => (
    <Document
      title="Page not found — Robbie Wadley"
      description="This page could not be found. Head home to explore Robbie Wadley’s work."
      path={routes.notFound.href()}
    >
      <Header home={false} />
      <main>
        <section class="hero">
          <p class="hero-label mono">404</p>
          <div class="section-head">
            <p class="mono">Lost your way?</p>
            <h1>Page not found.</h1>
            <p class="section-note">This page isn’t here. There’s plenty to explore back home.</p>
          </div>
          <div class="hero-foot">
            <a class="pill" href={routes.home.href()}>
              Back home <span aria-hidden="true"><Arrow /></span>
            </a>
          </div>
        </section>
      </main>
    </Document>
  );
}
