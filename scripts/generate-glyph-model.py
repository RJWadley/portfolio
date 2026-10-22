"""Compile the vendored font's TrueType variation tuples, including IUP deltas.
Rebuild: uv run --with fonttools==4.67.0 --with brotli==1.2.0 scripts/generate-glyph-model.py
The browser evaluates the font's own normalized support regions; no fitted axes.
"""

import base64
import zlib
from pathlib import Path
from fontTools.ttLib import TTFont

font = TTFont("app/ui/public/fonts/google-sans-flex.woff2")
models = {}


def glyph(name):
    if name in models:
        return
    coords, controls = font["glyf"]._getCoordinatesAndControls(
        name, font["hmtx"].metrics
    )
    model = {
        "points": list(coords),
        "ends": controls.endPts,
        "flags": list(controls.flags or []),
        "supports": [v.axes for v in font["gvar"].variations[name]],
    }
    if controls.components:
        model["components"] = [n for n, _ in controls.components]
        for n, _ in controls.components:
            glyph(n)
    models[name] = model


chars = {c: font.getBestCmap()[ord(c)] for c in dict.fromkeys("RobbieWadley")}
for n in chars.values():
    glyph(n)
data = {
    "upem": font["head"].unitsPerEm,
    "axes": {
        a.axisTag: [a.minValue, a.defaultValue, a.maxValue] for a in font["fvar"].axes
    },
    "chars": chars,
    "glyphs": models,
}

# Preserve the font's integer control points and sparse integer gvar deltas.
# The offline geometry generator reconstructs IUP and the quadratic samples.
payload = bytearray()


def uint(value):
    while value > 127:
        payload.append((value & 127) | 128)
        value >>= 7
    payload.append(value)


def sint(value):
    uint(value * 2 if value >= 0 else -value * 2 - 1)


supports = []
for model in models.values():
    for support in model["supports"]:
        if support not in supports:
            supports.append(support)
uint(data["upem"])
tags = list(data["axes"])
uint(len(tags))
for tag in tags:
    payload.extend(tag.encode("ascii"))
    for value in data["axes"][tag]:
        sint(round(value * 16384))
uint(len(supports))
for support in supports:
    uint(len(support))
    for tag, region in support.items():
        uint(tags.index(tag))
        for value in region:
            sint(round(value * 16384))
names = list(models)
uint(len(names))
for name, model in models.items():
    uint(len(model["points"]))
    for x, y in model["points"]:
        sint(x)
        sint(y)
    uint(len(model["ends"]))
    last = -1
    for end in model["ends"]:
        uint(end - last)
        last = end
    uint(len(model["flags"]))
    for flag in model["flags"]:
        uint(flag & 1)
    uint(len(model.get("components", [])))
    for child in model.get("components", []):
        uint(names.index(child))
    variations = font["gvar"].variations[name]
    uint(len(variations))
    for variation in variations:
        uint(supports.index(variation.axes))
        explicit = [
            (i, delta)
            for i, delta in enumerate(variation.coordinates)
            if delta is not None
        ]
        uint(len(explicit))
        last = -1
        for i, (x, y) in explicit:
            uint(i - last)
            last = i
            sint(x)
            sint(y)
uint(len(chars))
for char, name in chars.items():
    uint(ord(char))
    uint(names.index(name))
encoded = base64.b64encode(zlib.compress(payload, 9)).decode("ascii")
Path("scripts/fixtures/glyph-font-source.js").write_text(
    '// Generated from the bundled OFL font by scripts/generate-glyph-model.py.\nexport default "'
    + encoded
    + '";\n'
)
print(
    f"Packed {len(chars)} glyphs: {len(payload)} bytes before deflate, {len(encoded)} base64 bytes"
)
