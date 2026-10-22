import { Arrow } from "./arrow.tsx";
import type { Handle } from "remix/component";
import { routes } from "../routes.ts";
import { archiveItems } from "../data/portfolio.ts";
import {
  WorkCards,
  ArchiveList,
  OpenSource,
  Timeline,
  Playground,
} from "./collections.tsx";
import { ProjectArchive } from "./public/project-archive.tsx";
import { WordRoller } from "./public/word-roller.tsx";

export function Header(handle: Handle<{ home?: boolean }>) {
  return () => (
    <header class="site-header">
      {"\n      "}
      <a
        class="wordmark"
        href={
          handle.props.home === false ? routes.home.href() + "#top" : "#top"
        }
        aria-label="Robbie Wadley, back to top"
      >
        <span>{"R"}</span>
        <span>{"W"}</span>
        <span class="slash">{"/"}</span>
      </a>
      {"\n    "}
    </header>
  );
}

export function Footer() {
  return () => (
    <footer class="contact" id="contact">
      {"\n      "}
      <p class="mono">{"04 — Contact"}</p>
      {"\n      "}
      <h2 class="contact-big">
        <a href="mailto:robbiethewadley@gmail.com">
          <span data-spring>{"Say hi"}</span>
          <span class="contact-arrow" aria-hidden="true">
            <Arrow direction="right" />
          </span>
        </a>
      </h2>
      {"\n      "}
      <div class="contact-row">
        {"\n        "}
        <a href="mailto:robbiethewadley@gmail.com">
          {"robbiethewadley@gmail.com"}
        </a>
        {"\n        "}
        <a href="https://github.com/RJWadley" target="_blank" rel="noopener">
          {"GitHub "}<Arrow />
        </a>
        {"\n        "}
        <a
          href="https://www.linkedin.com/in/robbie-wadley-642276228/"
          target="_blank"
          rel="noopener"
        >
          {"LinkedIn "}<Arrow />
        </a>
        {"\n        "}
        <span class="mono">{"© 2026 Robbie Wadley"}</span>
        {"\n      "}
      </div>
      {"\n    "}
    </footer>
  );
}

export function Hero() {
  return () => (
    <section class="hero" id="top">
      {"\n        "}
      <h1 class="hero-name" aria-label="Robbie Wadley">
        {"\n          "}
        <span class="line" data-spring>
          {"Robbie"}
        </span>
        {"\n          "}
        <span class="line" data-spring>
          {"Wadley"}
          <span class="dot">{"."}</span>
        </span>
        {"\n        "}
      </h1>
      {"\n        "}
      <div class="hero-foot">
        {"\n          "}
        <p class="hero-intro">
          {"\n            I build\n            "}
          <WordRoller />
          <br />
          {"\n            "}
          <span class="sr-only">
            {"websites, apps, dev tools, and interfaces"}
          </span>
          {
            "\n            that feel alive, and the systems that keep them running.\n          "
          }
        </p>
        {"\n          "}
        <p class="hero-awards mono">
          {"\n            "}
          <span>
            <b>{"4×"}</b>
            {" Awwwards developer award"}
          </span>
          {"\n            "}
          <span>
            <b>{"6×"}</b>
            {" CSSDA Site of the Day"}
          </span>
          {"\n            "}
          <span>
            <b>{"1×"}</b>
            {" Webby"}
          </span>
          {"\n          "}
        </p>
        {"\n          "}
        <a class="hero-scroll pill" href="#work">
          {"Explore the work"} <span aria-hidden="true"><Arrow direction="down" /></span>
        </a>
        {"\n        "}
      </div>
      {"\n      "}
    </section>
  );
}

export function Work() {
  return () => (
    <section class="work" id="work" aria-labelledby="work-title">
      {"\n        "}
      <div class="section-head">
        {"\n          "}
        <p class="mono">{"01 — Selected work"}</p>
        {"\n          "}
        <h2 id="work-title">{"A few favorites."}</h2>
        {"\n          "}
        <p class="section-note">
          {
            "I spent four and a half years as a creative developer at Reform Collective, building award-winning sites with a small, sharp team. These are three of my favorites."
          }
        </p>
        {"\n        "}
      </div>
      {"\n\n        "}
      <WorkCards />
      {"\n\n        "}
      <ProjectArchive count={archiveItems.length} names={[...new Set(archiveItems.map((item) => item.name))]}>
        <ArchiveList />
      </ProjectArchive>
      {"\n      "}
    </section>
  );
}

export function UnderTheHood() {
  return () => (
    <section class="under" id="stack" aria-labelledby="stack-title">
      {"\n        "}
      <div class="section-head">
        {"\n          "}
        <p class="mono">{"02 — Under the hood"}</p>
        {"\n          "}
        <h2 id="stack-title">{"The rest of the stack."}</h2>
        {"\n          "}
        <p class="section-note">
          {
            "Pretty is only the top layer. I like apps, APIs, tooling, and the code that runs on real devices just as much."
          }
        </p>
        {"\n        "}
      </div>
      {"\n\n        "}
      <article class="konn3kt">
        {"\n          "}
        <div>
          {"\n            "}
          <p class="mono">
            <i class="live" aria-hidden="true"></i>
            {"In development"}
          </p>
          {"\n            "}
          <h3>
            {"Konn3kt "}
            <span>{"V3"}</span>
          </h3>
          {"\n          "}
        </div>
        {"\n          "}
        <div class="konn3kt-copy">
          {"\n            "}
          <p class="card-lead">
            {
              "IQ.Pilot is driver-assistance software for cars. Konn3kt is the app that goes with it, on web, iOS, and Android."
            }
          </p>
          {"\n            "}
          <p>
            {
              "I designed Konn3kt V3 and I’m building it, mostly frontend, with backend and device code where it’s needed. Before that I helped on the live V1 app and on iqdbc."
            }
          </p>
          {"\n            "}
          <a
            class="pill"
            href="https://iqlvbs.com/"
            target="_blank"
            rel="noopener"
          >
            {"About IQ.Pilot "}
            <span aria-hidden="true"><Arrow /></span>
          </a>
          {"\n          "}
        </div>
        {"\n          "}
        <dl class="pieces">
          <div>
            <dt>{"IQ.Pilot"}</dt>
            <dd>{"Runs on a small device mounted in the car, like a comma 3X. It helps steer, holds speed, navigates, and records bumps while you’re parked."}</dd>
          </div>
          <div>
            <dt>{"Konn3kt"}</dt>
            <dd>{"The companion app. Change settings over Bluetooth, download driving models, send destinations, and watch live or past drives. V3 brings devices, models, cameras, trip playback, and clip sharing into one place."}</dd>
          </div>
          <div>
            <dt>{"iqdbc"}</dt>
            <dd>{"The car definitions that let IQ.Pilot read and talk to each supported vehicle."}</dd>
          </div>
        </dl>
        {"\n        "}
      </article>
      {"\n\n        "}
      <h3 class="sub-head">{"Open source"}</h3>
      {"\n        "}
      <OpenSource />
      {"\n      "}
    </section>
  );
}

export function About() {
  return () => (
    <section class="about" id="about" aria-labelledby="about-title">
      {"\n        "}
      <div class="section-head">
        {"\n          "}
        <p class="mono">{"03 — About"}</p>
        {"\n          "}
        <h2 id="about-title">{"Curious, mostly."}</h2>
        {"\n        "}
      </div>
      {"\n        "}
      <div class="about-grid">
        {"\n          "}
        <p class="about-lead">
          {
            "I like figuring out how things work, then making them work better, and making them a little more fun along the way."
          }
        </p>
        {"\n          "}
        <Timeline />
        {"\n        "}
      </div>
      {"\n\n        "}
      <div class="play">
        {"\n          "}
        <p class="mono">{"Side quests"}</p>
        {"\n          "}
        <Playground />
        {"\n        "}
      </div>
      {"\n      "}
    </section>
  );
}
