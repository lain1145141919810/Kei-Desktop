"""Extract four unchanged LumenAct spans and rebase their catalog offsets."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1] / "plugins/lumenact"
sys.path.insert(0, str(PLUGIN))
from catalog import ASSET_REVISION, PINNED, SOURCE_REVISION, pinned_file

IDS = ("0", "5", "23", "77")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("resources", type=Path, help="Parent directory of models/expression")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    meta_name = "models/expression/catalog.json"
    data_name = "models/expression/curves.f32"
    catalog = json.loads(pinned_file(args.resources, meta_name).read_text("utf-8"))
    source = pinned_file(args.resources, data_name).read_bytes()
    styles_by_id = {str(style["id"]): style for style in catalog["styles"]}
    stride = catalog["channel_count"] * 4
    current = 0
    styles = []
    spans = []
    provenance = []
    for ident in IDS:
        style = styles_by_id[ident]
        offset, count = style["offset"], style["frames"]
        raw = source[offset * stride:(offset + count) * stride]
        assert len(raw) == count * stride
        spans.append(raw)
        styles.append({**style, "offset": current})
        provenance.append({"id": ident, "originalOffset": offset, "frames": count,
                           "sha256": hashlib.sha256(raw).hexdigest()})
        current += count

    args.output.mkdir(parents=True, exist_ok=True)
    # The rest of the upstream catalog is not an index for this subset.
    reduced = {key: catalog[key] for key in ("schema", "fps", "channel_count", "channels", "curves", "neutral_style")}
    reduced["styles"] = styles
    digest = {"sourceRevision": SOURCE_REVISION, "assetRevision": ASSET_REVISION,
              "sourceCatalogSha256": PINNED[meta_name][1], "sourceCurvesSha256": PINNED[data_name][1],
              "changes": "Selected full spans and rebased offsets. No sample values changed.", "spans": provenance}
    (args.output / "catalog.json").write_bytes((json.dumps(reduced, ensure_ascii=False, indent=2) + "\n").encode())
    (args.output / "curves.f32").write_bytes(b"".join(spans))
    (args.output / "provenance.json").write_bytes((json.dumps(digest, indent=2) + "\n").encode())


if __name__ == "__main__":
    main()
