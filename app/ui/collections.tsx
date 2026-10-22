import { Arrow } from "./arrow.tsx";
import {
  workCards,
  archiveItems,
  openSource,
  timeline,
  playground,
} from "../data/portfolio.ts";

export function WorkCards() {
  return () => (
    <ol class="work-grid" role="list">
      {workCards.flatMap((card) => {
        const newform = card.title === "New Form Capital";
        const variant = newform ? "newform" : card.title.toLowerCase();
        const sizes = newform
          ? "(max-width: 600px) calc(100vw - 40px), 63vw"
          : card.title === "Runway"
            ? "(max-width: 600px) calc(58vw - 24px), 40vw"
            : "(max-width: 600px) calc(100vw - 40px), 55vw";
        return [
          <li
            key={card.title}
            class={`card work-tile work-tile-${variant}`}
            style={card.style}
            data-cursor={card.cursor}
          >
            <a
              class="work-link"
              href={card.href}
              target="_blank"
              rel="noopener"
              aria-label={`${card.linkText} — ${card.title}`}
            >
              <span class="card-media" style={{ aspectRatio: `${card.width} / ${card.height}` }}>
                <img
                  src={card.image}
                  srcset={`${card.image.replace(".webp", "-640.webp")} 640w, ${card.image.replace(".webp", "-960.webp")} 960w, ${card.image} ${card.width}w`}
                  sizes={sizes}
                  alt=""
                  width={card.width}
                  height={card.height}
                  loading="lazy"
                  decoding="async"
                />
                {card.video && (
                  <video muted loop playsinline preload="none" data-src={card.video} aria-hidden="true" />
                )}
              </span>
              <div class="work-caption">
                <div class="work-title">
                  <h3>{card.title}</h3>
                  <span class="mono">{card.index.split(" · ")[1]}</span>
                  <Arrow />
                </div>
                {!newform && <p class="work-recognition">{card.recognition}</p>}
              </div>
            </a>
          </li>,
          ...(newform ? [
            <li key="newform-recognition" class="work-detail">
              <span class="mono">New Form Capital · 2022</span>
              <p class="work-detail-title">Site<br />of the<br /><em>day.</em></p>
              <p class="work-detail-credit">CSS Design Awards</p>
            </li>,
          ] : []),
        ];
      })}
    </ol>
  );
}

export function ArchiveList() {
  return () => (
    <ol class="archive-list" role="list">
      {archiveItems.map((item, i) => (
        <li key={i}>
          <span class="archive-number" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
          <span class="archive-name">{item.name}</span>
          {item.note && <small>{item.note}</small>}
        </li>
      ))}
    </ol>
  );
}

export function OpenSource() {
  return () => (
    <ul class="oss" role="list">
      {openSource.flatMap((item) => [
        <li key={item.name}>
          <a href={item.href} target="_blank" rel="noopener">
            <span class="oss-name">{item.name}</span>
            <span class="oss-what">{item.description}</span>
            <span class="oss-tag mono">{item.tag}</span>
            <span class="arrow" aria-hidden="true">
              <Arrow />
            </span>
          </a>
        </li>,
        "\n",
      ])}
    </ul>
  );
}
export function Timeline() {
  return () => (
    <ol class="timeline" role="list">
      {timeline.flatMap((item) => [
        <li key={item.duration}>
          <span class="mono">{item.duration}</span>
          <div>
            <b>{item.name}</b>
            <small>{item.description}</small>
          </div>
        </li>,
        "\n",
      ])}
    </ol>
  );
}
export function Playground() {
  return () => (
    <div class="play-grid">
      {playground.flatMap((item) => [
        <a
          key={item.name}
          class="play-card"
          href={item.href}
          target="_blank"
          rel="noopener"
        >
          <img
            src={item.image}
            alt={item.alt}
            width={item.width}
            height={item.height}
            loading="lazy"
            decoding="async"
          />
          <span>
            <b>{item.name}</b>
            {" "}
            {item.description}
            {" "}
            <span aria-hidden="true"><Arrow /></span>
          </span>
        </a>,
        "\n",
      ])}
    </div>
  );
}
