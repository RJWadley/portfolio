import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseHtml, type DefaultTreeAdapterMap } from "parse5";
import { init, parse as parseModules } from "es-module-lexer";
import { assets } from "../app/assets.ts";
import { router } from "../app/router.ts";
import { routes } from "../app/routes.ts";

const origin = "http://localhost";
const output = path.resolve("dist");
const queue = new Set<string>();
const saved = new Set<string>();
const imports: Record<string, string> = {};
const scopes: Record<string, Record<string, string>> = {};
const documents = new Map<string, string>();
const staticUrl = (url: string) => url.replace(/\.(?:tsx?|jsx)$/, ".js");
const manifest: { url: string; bytes: number; type: string }[] = [];

function enqueue(value: string, base = origin + "/") {
  if (!value || /^(?:data:|blob:|mailto:|#)/i.test(value)) return;
  const url = new URL(value, base);
  if (url.origin !== origin) return;
  if (url.search)
    throw new Error(`Static export needs a path-only asset URL: ${url}`);
  queue.add(url.pathname);
}
function collectJson(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "moduleUrl" && typeof item === "string") enqueue(item);
    else collectJson(item);
  }
}
function collectHtml(html: string, base: string) {
  function visit(node: DefaultTreeAdapterMap["node"]) {
    if ("attrs" in node) {
      const attrs = Object.fromEntries(
        node.attrs.map((a) => [a.name, a.value]),
      );
      for (const key of ["src", "data-src", "poster"])
        if (attrs[key]) enqueue(attrs[key], base);
      if (
        node.tagName === "link" &&
        attrs.href &&
        /(?:stylesheet|preload|icon)/.test(attrs.rel ?? "")
      )
        enqueue(attrs.href, base);
      // Traverse every responsive work image candidate, including sizes not chosen
      // by the viewport used during browser verification.
      if (attrs.srcset)
        for (const item of attrs.srcset.split(","))
          enqueue(item.trim().split(/\s+/)[0], base);
      if (attrs.style) collectCss(attrs.style, base);
      if (node.tagName === "style")
        collectCss(
          node.childNodes
            .filter((n) => "value" in n)
            .map((n) => (n as DefaultTreeAdapterMap["textNode"]).value)
            .join(""),
          base,
        );
      if (node.tagName === "script") {
        const text = node.childNodes
          .filter((n) => "value" in n)
          .map((n) => (n as DefaultTreeAdapterMap["textNode"]).value)
          .join("");
        if (attrs.type === "importmap") {
          const map = JSON.parse(text);
          Object.assign(imports, map.imports);
          for (const [scope, entries] of Object.entries(map.scopes ?? {})) {
            Object.assign((scopes[scope] ??= {}), entries);
          }
          for (const target of Object.values(map.imports ?? {}))
            enqueue(String(target), base);
          for (const entries of Object.values(map.scopes ?? {}))
            for (const target of Object.values(
              entries as Record<string, string>,
            ))
              enqueue(target, base);
        } else if (attrs.type === "application/json")
          collectJson(JSON.parse(text));
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
    if ("content" in node) visit(node.content);
  }
  visit(parseHtml(html));
}
function collectCss(css: string, base: string) {
  for (const match of css.matchAll(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|@import\s+["']([^"']+)["']/g,
  ))
    enqueue((match[1] ?? match[2] ?? match[3] ?? match[4]).trim(), base);
}
function resolveImport(specifier: string, parent: string) {
  const absolute = /^(?:\.|\/|https?:)/.test(specifier)
    ? new URL(specifier, origin + parent).href
    : specifier;
  const candidates = [
    specifier,
    absolute,
    absolute.startsWith(origin) ? absolute.slice(origin.length) : absolute,
  ];
  const maps = Object.entries(scopes)
    .filter(([scope]) =>
      (origin + parent).startsWith(new URL(scope, origin).href),
    )
    .sort((a, b) => b[0].length - a[0].length)
    .map(([, map]) => map)
    .concat(imports);
  for (const map of maps)
    for (const candidate of candidates) {
      if (map[candidate]) return map[candidate];
      const prefix = Object.keys(map)
        .filter((k) => k.endsWith("/") && candidate.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (prefix) return map[prefix] + candidate.slice(prefix.length);
    }
  if (!/^(?:\.|\/|https?:)/.test(specifier))
    throw new Error(`Unmapped import ${specifier} in ${parent}`);
  return absolute;
}
async function write(url: string, content: Uint8Array | string) {
  const target = path.resolve(output, "." + decodeURIComponent(url));
  if (!target.startsWith(output + path.sep))
    throw new Error(`Unsafe output path: ${url}`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
async function publicFiles(directory: string, prefix = "") {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    if (file.isDirectory())
      await publicFiles(
        path.join(directory, file.name),
        `${prefix}/${file.name}`,
      );
    else enqueue(`${prefix}/${file.name}`);
  }
}

try {
  if (process.env.NODE_ENV !== "production")
    throw new Error("Prerender must run with NODE_ENV=production");
  await init;
  await rm(output, { recursive: true, force: true });
  const pages = [
    routes.home.href(),
    routes.work.show.href({ slug: "new-form" }),
  ];
  for (const page of [...pages, routes.notFound.href()]) {
    const response = await router.fetch(new Request(origin + page));
    const expectedStatus = page === routes.notFound.href() ? 404 : 200;
    if (response.status !== expectedStatus) throw new Error(`Page ${page}: ${response.status}`);
    const html = await response.text();
    documents.set(
      page === "/" ? "/index.html" : `${page.replace(/\/$/, "")}.html`,
      html,
    );
    collectHtml(html, origin + page);
  }
  // Includes deferred videos, social images, and classic vendor scripts, even before they are requested.
  await publicFiles("public");
  enqueue(await assets.getHref("app/ui/public/fonts/Google-Sans-Flex-OFL.txt"));
  while (queue.size) {
    const url = queue.values().next().value!;
    queue.delete(url);
    if (saved.has(url)) continue;
    const response = await router.fetch(new Request(origin + url));
    if (!response.ok) throw new Error(`Asset ${url}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    saved.add(url);
    manifest.push({ url, bytes: bytes.byteLength, type });
    if (type.includes("javascript") && !url.startsWith("/vendor/")) {
      const [dependencies] = parseModules(new TextDecoder().decode(bytes));
      let script = new TextDecoder().decode(bytes);
      for (const dependency of [...dependencies].reverse())
        if (dependency.specifier) {
          const target = resolveImport(dependency.specifier, url);
          enqueue(target);
          // Keep authored/stable specifiers and the document import map in control of
          // dependency versions. Embedding dependency fingerprints here would change a
          // parent's bytes without changing the fingerprint assigned by Remix.
          const replacement = staticUrl(dependency.specifier);
          script =
            script.slice(0, dependency.start) +
            (dependency.type !== "dynamic"
              ? replacement
              : JSON.stringify(replacement)) +
            script.slice(dependency.end);
        }
      await write(staticUrl(url), script);
    } else {
      if (type.includes("css"))
        collectCss(new TextDecoder().decode(bytes), origin + url);
      await write(staticUrl(url), bytes);
    }
  }
  for (const [url, html] of documents)
    await write(
      url,
      html.replace(
        /(\/assets\/[^\s"'<>\\]+?)\.(?:tsx?|jsx)(?=["'<>\s])/g,
        "$1.js",
      ),
    );
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((page) => `  <url><loc>https://www.robbiewadley.com${page}</loc></url>`).join("\n")}\n</urlset>\n`;
  await write("/sitemap.xml", sitemap);
  manifest.push({ url: "/sitemap.xml", bytes: Buffer.byteLength(sitemap), type: "application/xml" });
  await mkdir(".verify", { recursive: true });
  await writeFile(
    ".verify/asset-manifest.json",
    JSON.stringify({ pages, assets: manifest }, null, 2),
  );
  console.log(
    `Prerendered ${pages.length} pages, 404.html, and ${manifest.length} assets to dist/`,
  );
} finally {
  await assets.close();
}
