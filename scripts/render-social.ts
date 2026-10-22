// Regenerate the share image using the site's sole font: pnpm exec node --import remix/node-tsx scripts/render-social.ts
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const font = await readFile("app/ui/public/fonts/google-sans-flex.woff2");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><style>
    @font-face { font-family:'Google Sans Flex'; src:url(data:font/woff2;base64,${font.toString("base64")}); font-weight:1 1000; }
    * { box-sizing:border-box; }
    body { margin:0; width:1200px; height:630px; padding:48px 56px; background:#ecede8; color:#111311; font-family:'Google Sans Flex'; }
    .label { font-size:16px; letter-spacing:.12em; text-transform:uppercase; font-variation-settings:'wght' 640,'wdth' 80,'GRAD' 20,'ROND' 70; }
    h1 { font-size:170px; line-height:.95; letter-spacing:-.06em; font-weight:760; font-variation-settings:'ROND' 30; margin:52px 0 36px -7px; }
    .last { margin-left:110px; }
    .dot { display:inline-block; width:29px; height:29px; border-radius:10px; margin-left:8px; background:#c8f53c; }
    footer { border-top:1px solid #11131130; padding-top:18px; display:flex; justify-content:space-between; }
  </style><p class="label">Robbie Wadley · Full-stack engineer</p><h1>Robbie<br><span class="last">Wadley<span class="dot"></span></span></h1><footer class="label"><span>Websites, interfaces & the systems underneath.</span><span>robbiewadley.com</span></footer>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: "public/images/og.jpg", type: "jpeg", quality: 92 });
} finally { await browser.close(); }
