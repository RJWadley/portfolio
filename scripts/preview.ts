import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToRegexp } from "path-to-regexp";
import serveHandler from "serve-handler";

// Use the same static files, URL policy, and header patterns as the deployment.
// serve-handler supplies MIME types, range requests, extensionless HTML lookup,
// and the exported 404.html with status 404 for unknown paths, as Vercel does.
export async function startPreview({ port = 0, host = "127.0.0.1", directory }: { port?: number; host?: string; directory?: string } = {}) {
  const config = JSON.parse(await readFile("vercel.json", "utf8")) as {
    outputDirectory: string;
    cleanUrls: boolean;
    trailingSlash: boolean;
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  const headers = config.headers.map((rule) => ({
    pattern: pathToRegexp(rule.source, [], { sensitive: true, strict: true }),
    headers: rule.headers,
  }));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let canonical = url.pathname;
    if (config.cleanUrls) canonical = canonical.replace(/(?:\/index)?\.html$/, "");
    if (!config.trailingSlash) canonical = canonical.replace(/\/+$/, "");
    canonical ||= "/";
    if (canonical !== url.pathname) {
      response.writeHead(308, { Location: canonical + url.search });
      response.end();
      return;
    }
    // Vercel matches request paths with regexes. serve-handler's header globs
    // skip dot directories such as pnpm's exported .pnpm module paths.
    for (const rule of headers)
      if (rule.pattern.test(url.pathname))
        for (const header of rule.headers) response.setHeader(header.key, header.value);
    void serveHandler(request, response, {
      public: directory ?? process.env.VERIFY_DIRECTORY ?? config.outputDirectory,
      cleanUrls: config.cleanUrls,
      trailingSlash: config.trailingSlash,
      directoryListing: false,
    }).catch((error: unknown) => {
      console.error(error);
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview did not bind a TCP port");
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

if (import.meta.main) {
  const preview = await startPreview({
    port: Number(process.env.PORT ?? 5190),
    host: process.env.HOST ?? "0.0.0.0",
  });
  console.log(`Static preview listening on ${preview.url}`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await preview.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
