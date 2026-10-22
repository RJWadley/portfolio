# Portfolio

This repository uses Remix 3.0.0 and its non-React component runtime. Before using unfamiliar framework APIs, read `.agents/skills/remix/SKILL.md`, then follow the relevant guide in `node_modules/remix/INDEX.md`.

Use pnpm for commands and dependency changes. `package.json` and `pnpm-lock.yaml` own the package-manager and Node runtime pins; pnpm installs the runtime automatically. Put pnpm settings in `pnpm-workspace.yaml`.

Preserve the global stylesheet and interaction mechanics in `app/ui/public/`. Components start browser setup after commit and own resources through `handle.signal`, ref signals, and `Lifetime`. Physics letters and the cursor ball share one engine. Keep Matter and poly-decomp as vendored classic scripts: Remix rejects their CommonJS package builds.

When changing routes or assets, update the explicit route list and asset traversal in `scripts/prerender.ts`; it also generates the sitemap and exports `404.html`. Static output uses `.js` extensions for compiled modules, with matching import-map and import-specifier rewrites, including literal dynamic imports. Keep fonts and their OFL license in `app/ui/public/fonts/`. Debug behavior loads only for `?debug`. Keep document/hash navigation and generate links through `app/routes.ts`. Vercel and local preview serve extensionless page URLs without trailing slashes and branded unknown paths with status 404.

After structural changes, run `pnpm typecheck`, `pnpm test`, `pnpm exec remix doctor`, `pnpm build`, and `pnpm verify`. For UI changes, inspect the screenshots and interaction/lifecycle report in `.verify/`; verification starts and stops its own static preview and needs no reference site. See `README.md` for browser setup.
