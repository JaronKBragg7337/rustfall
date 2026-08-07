"""Build atlas_industrial: a 3x3 grid-labeled CC0 texture sheet for RUSTFALL.

Downloads 1K JPG packs from ambientCG (CC0), takes the Color map of each,
composes a 2048px master PNG (assets/atlases/) and a 1536px WebP runtime sheet
(public/textures/), matching the format of the existing atlases:
  - dark gutters (~1.8% of cell width, skipped by the runtime slicer)
  - bottom 20% of each cell = label strip (dropped by the runtime slicer)
Also runs the doctrine Part 4B albedo sanity check and lifts dark cells.
"""
import io, json, os, sys, urllib.request, zipfile
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "assets", "atlases", "atlas_industrial.png")
RUNTIME = os.path.join(ROOT, "public", "textures", "atlas_industrial.webp")

# card key, label, candidates in preference order (first that downloads wins)
CELLS = [
    ("IND01", "Corrugated steel", ["CorrugatedSteel005", "CorrugatedSteel002", "CorrugatedSteel001"]),
    ("IND02", "Painted metal",    ["Metal032", "Metal033", "Metal027"]),
    ("IND03", "Weathered wood",   ["Planks037", "Planks003", "WoodSiding001", "WoodSiding010"]),
    ("IND04", "Cast concrete",    ["Concrete034", "Concrete033", "Concrete030"]),
    ("IND05", "Damaged brick",    ["Bricks051", "Bricks076", "Bricks059"]),
    ("IND06", "Gravel ballast",   ["Ground054", "Ground049A", "Ground048"]),
    ("IND07", "Patched asphalt",  ["Asphalt019", "Asphalt028", "Road003", "Road002", "Asphalt021"]),
    ("IND08", "Tread plate",      ["MetalPlates006", "MetalPlates007", "MetalPlates001"]),
    ("IND09", "Worn tarp fabric", ["Fabric023", "Fabric026", "Fabric013"]),
]

SIZE = 2048
GUTTER_RATIO = 0.018
LABEL_RATIO = 0.20
BG = (26, 24, 22)
STRIP = (14, 13, 12)


def fetch_color(asset_id: str) -> Image.Image | None:
    url = f"https://ambientcg.com/get?file={asset_id}_1K-JPG.zip"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        zf = zipfile.ZipFile(io.BytesIO(data))
        name = next(n for n in zf.namelist() if "Color" in n and n.lower().endswith(".jpg"))
        img = Image.open(io.BytesIO(zf.read(name))).convert("RGB")
        print(f"  ok {asset_id} -> {name} {img.size}")
        return img
    except Exception as e:  # noqa: BLE001
        print(f"  FAIL {asset_id}: {e}")
        return None


def srgb_to_linear(c: float) -> float:
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def albedo_sanity(img: Image.Image, key: str) -> Image.Image:
    """Doctrine Part 4B: photographic cells are often too dark to be plausible
    albedo. Measure mean linear albedo; lift with gamma if below floor."""
    small = img.resize((64, 64))
    px = list(small.getdata())
    lin = sum(0.2126 * srgb_to_linear(r) + 0.7152 * srgb_to_linear(g) + 0.0722 * srgb_to_linear(b)
              for r, g, b in px) / len(px)
    FLOOR, TARGET = 0.10, 0.22
    if lin < FLOOR:
        gamma = 0.65
        lut = [min(255, round(255 * (i / 255) ** gamma)) for i in range(256)]
        img = img.point(lut * 3)
        print(f"  {key}: linear albedo {lin:.3f} < {FLOOR} -> gamma lift {gamma}")
    else:
        print(f"  {key}: linear albedo {lin:.3f} ok")
    return img


def load_font(px: int, bold=True):
    for name in ("consola.ttf", "arialbd.ttf" if bold else "arial.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(f"C:/Windows/Fonts/{name}", px)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    atlas = Image.new("RGB", (SIZE, SIZE), BG)
    draw = ImageDraw.Draw(atlas)
    cell = SIZE / 3
    gutter = round(cell * GUTTER_RATIO)
    label_h = round(cell * LABEL_RATIO)
    f_big = load_font(40)
    f_small = load_font(24, bold=False)
    manifest = []

    for idx, (key, label, candidates) in enumerate(CELLS):
        row, col = divmod(idx, 3)
        img = None
        used = None
        for cand in candidates:
            img = fetch_color(cand)
            if img is not None:
                used = cand
                break
        if img is None:
            sys.exit(f"No candidate worked for {key} ({label})")

        # Grunge pass: clean photos read wrong next to the weathered wasteland
        # atlases. Desaturate + mute so the new surfaces age into the palette.
        if key in ("IND05",):  # fresh brick -> aged brick
            from PIL import ImageEnhance
            img = ImageEnhance.Color(img).enhance(0.45)
            img = ImageEnhance.Brightness(img).enhance(0.82)

        img = albedo_sanity(img, key)

        # crop to a centred square so non-square sources (e.g. 1024x512) don't distort
        w, h = img.size
        if w != h:
            s = min(w, h)
            img = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))

        x0, y0 = round(col * cell), round(row * cell)
        tex_area = (round(cell) - gutter, round(cell) - gutter)
        img = img.resize(tex_area, Image.LANCZOS)
        atlas.paste(img, (x0 + gutter // 2, y0 + gutter // 2))

        # label strip across the bottom 20% of the cell
        sy = y0 + round(cell) - label_h
        draw.rectangle([x0, sy, x0 + round(cell), y0 + round(cell)], fill=STRIP)
        draw.text((x0 + 18, sy + 14), f"TEX-IND-{key[3:]}  {label}", font=f_big, fill=(232, 226, 214))
        draw.text((x0 + 18, sy + label_h - 40), f"CC0 ambientCG.com/{used}", font=f_small, fill=(140, 134, 124))
        manifest.append({"card": key, "label": label, "source": f"ambientCG {used}", "license": "CC0"})

    os.makedirs(os.path.dirname(MASTER), exist_ok=True)
    atlas.save(MASTER)
    runtime = atlas.resize((1536, 1536), Image.LANCZOS)
    os.makedirs(os.path.dirname(RUNTIME), exist_ok=True)
    runtime.save(RUNTIME, "WEBP", quality=82)
    with open(os.path.join(ROOT, "assets", "atlases", "ATLAS_INDUSTRIAL_SOURCES.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"wrote {MASTER}\nwrote {RUNTIME}")


if __name__ == "__main__":
    main()
