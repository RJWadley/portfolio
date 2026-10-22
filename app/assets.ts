import { createAssetServer } from "remix/assets";
import { componentHmr } from "remix/component-hmr/assets";

const rootDir = process.cwd();
const nodeEnv = process.env.NODE_ENV ?? "development";
const isDevelopment = nodeEnv === "development";
const isHmr = Boolean(isDevelopment && process.env.REMIX_NODE_HMR);

export const assets = createAssetServer({
  basePath: "/assets",
  rootDir,

  allowFiles: ["app/routes.ts", "app/**/public/**"],
  allowPackages: ["remix"],
  files: { extensions: [".woff2", ".txt", ".svg", ".webp", ".jpg", ".png", ".webm"] },
  denyFiles: ["app/**/*.test.*"],
  sourceMaps: isDevelopment ? "external" : undefined,
  minify: !isDevelopment,
  watch: isDevelopment,
  fingerprint: !isDevelopment,
  hmr: isHmr
    ? {
        channel: async () =>
          (await import("remix/node-hmr/runtime")).createBrowserHmrChannel(),
        moduleImporter: "remix/multiple-import-maps-polyfill",
      }
    : undefined,
  scripts: { loaders: isHmr ? [componentHmr()] : undefined },
});

const entry = "app/actions/public/entry.ts";

export const scriptEntry = await assets.getScriptEntry(entry);

export const stylesheet = await assets.getHref("app/ui/public/styles.css");

export const preloadFont = await assets.getHref("app/ui/public/fonts/google-sans-flex.woff2");
