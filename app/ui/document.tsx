import type { Handle, RemixNode } from "remix/component";
import { ImportMap } from "remix/component/server";
import { scriptEntry, stylesheet, preloadFont } from "../assets.ts";
export function Document(
  handle: Handle<{
    children?: RemixNode;
    title?: string;
    description?: string;
    path?: string;
  }>,
) {
  return () => {
    const {
      children,
      title = "Robbie Wadley — Full-stack engineer",
      description,
      path = "/",
    } = handle.props;
    const metaDescription = description ?? "Robbie Wadley is a full-stack engineer building expressive websites, product interfaces, and open-source tools. Four-time Awwwards developer award winner.";
    const socialDescription = description ?? "Expressive websites, product interfaces, and the software underneath them.";
    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{title}</title>
          <meta
            name="description"
            content={metaDescription}
          />
          <meta name="theme-color" content="#ecede8" />
          <meta
            property="og:title"
            content={title}
          />
          <meta
            property="og:description"
            content={socialDescription}
          />
          <meta property="og:type" content="website" />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:title" content={title} />
          <meta name="twitter:description" content={socialDescription} />
          <meta name="twitter:image" content="https://www.robbiewadley.com/images/og.jpg" />
          <meta
            property="og:image"
            content="https://www.robbiewadley.com/images/og.jpg"
          />
          <meta
            property="og:url"
            content={"https://www.robbiewadley.com" + path}
          />
          <link rel="canonical" href={"https://www.robbiewadley.com" + path} />
          <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
          <link
            rel="preload"
            href={preloadFont}
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
          />
          <link rel="stylesheet" href={stylesheet} />
          <script>{"document.documentElement.classList.add('js')"}</script>
          <script src="/vendor/decomp.min.js" defer></script>
          <script src="/vendor/matter.min.js" defer></script>
          <ImportMap value={scriptEntry.importMap} />
          {scriptEntry.preloads.map((href) => (
            <link key={href} rel="modulepreload" href={href} />
          ))}
          <script type="module" src={scriptEntry.href}></script>
        </head>
        <body>{children}</body>
      </html>
    );
  };
}
