"""Prepare Google's v23 Latin variable font without clipping its expressive axes.

uvx --from 'fonttools[woff]' python scripts/prepare-font.py /path/to/latin.woff2 /path/to/OFL.txt
"""
from io import BytesIO
from pathlib import Path
import sys
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

source, license_path = map(Path, sys.argv[1:])
font = TTFont(source, recalcTimestamp=False)
# Pin the expensive optical axis; retain wdth 25–151, wght 1–1000,
# GRAD/ROND 0–100, and slnt -10–0 in their entirety.
instantiateVariableFont(font, {"opsz": 18}, inplace=True)
# Reload after instancing: fonttools' lazy gvar map can retain removed empty entries.
instance = BytesIO()
font.flavor = None
font.save(instance)
instance.seek(0)
font = TTFont(instance, recalcTimestamp=False)
characters = set(range(32, 127)) | {0xA0, 0xB7, 0xD7, 0x2026} | set(range(0x2018, 0x2020))
for path in Path("app").rglob("*"):
    if path.suffix in {".tsx", ".ts", ".js", ".css"}:
        characters.update(map(ord, path.read_text()))
options = subset.Options()
options.layout_features = ["*"]
options.recalc_timestamp = False
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=characters)
subsetter.subset(font)
font.flavor = "woff2"
output = Path("app/ui/public/fonts/google-sans-flex.woff2")
font.save(output)
Path("app/ui/public/fonts/Google-Sans-Flex-OFL.txt").write_text(license_path.read_text().replace("\\r\\n", "\n"))
# SVG images cannot use the document's downloaded font. Outline the same rest pose.
glyphs = font.getGlyphSet(location={"wght": 760, "ROND": 30})
cmap = font.getBestCmap()
paths, x = [], 0
for char in "RW":
    name = cmap[ord(char)]
    pen = SVGPathPen(glyphs)
    glyphs[name].draw(TransformPen(pen, (1, 0, 0, 1, x, 0)))
    paths.append(pen.getCommands())
    x += glyphs[name].width - 35
scale = 43 / x
Path("public/favicon.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111311"/><path d="{" ".join(paths)}" transform="translate(10 44) scale({scale} {-scale})" fill="#ecede8"/><rect x="44" y="12" width="8" height="8" rx="2" fill="#c8f53c"/></svg>\n')
print(f"{output}: {output.stat().st_size:,} bytes, {len(cmap)} characters")
