import { Document } from "../ui/document.tsx";
import {
  Header,
  Footer,
  Hero,
  Work,
  UnderTheHood,
  About,
} from "../ui/sections.tsx";
import { PhysicsLetters } from "../ui/public/physics-letters.tsx";
import { HangingSign } from "../ui/public/hanging-sign.tsx";
import { ScrollEffects } from "../ui/public/scroll-effects.tsx";
import { CursorLabel } from "../ui/public/cursor-label.tsx";
import { DebugOverlay } from "../ui/public/debug-overlay.tsx";
export function HomePage() {
  return () => (
    <Document>
      <a class="skip-link" href="#work">
        Skip to work
      </a>
      <Header />
      <HangingSign />
      <main>
        <Hero />
        <Work />
        <UnderTheHood />
        <About />
      </main>
      <Footer />
      <CursorLabel />
      <PhysicsLetters />
      <ScrollEffects />
      <DebugOverlay />
    </Document>
  );
}
