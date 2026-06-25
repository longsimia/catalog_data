from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageOps


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a WebP thumbnail for catalog images.")
    parser.add_argument("--input", required=True, help="Source image path")
    parser.add_argument("--output", required=True, help="Output WebP path")
    parser.add_argument("--max-edge", type=int, default=400, help="Maximum edge length")
    parser.add_argument("--quality", type=int, default=80, help="WebP quality")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = Path(args.input)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image)
        image.load()

        if image.mode not in ("RGB", "RGBA"):
            if "A" in image.getbands():
                image = image.convert("RGBA")
            else:
                image = image.convert("RGB")

        image.thumbnail((args.max_edge, args.max_edge), Image.Resampling.LANCZOS)
        image.save(output, format="WEBP", quality=max(1, min(args.quality, 100)), method=6)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
