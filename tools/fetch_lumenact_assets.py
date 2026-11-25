"""Fetch only the pinned LumenAct curve bank and optional ONNX resources."""
import argparse
import hashlib
import sys
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

PLUGIN = Path(__file__).resolve().parents[1] / "plugins/lumenact"
sys.path.insert(0, str(PLUGIN))
from catalog import ASSET_REVISION, PINNED, pinned_file

SOURCE = "https://huggingface.co/AaBbcoder/LumenAct/resolve/" + ASSET_REVISION + "/"


def fetch(root, name):
    try:
        pinned_file(root, name)
        return
    except ValueError:
        pass
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    size, expected = PINNED[name]
    digest = hashlib.sha256()
    count = 0
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + ".", delete=False) as stream:
            temporary = Path(stream.name)
            request = Request(SOURCE + name + "?download=true", headers={"User-Agent": "Kei-LumenAct/1.0"})
            with urlopen(request, timeout=90) as reply:
                while block := reply.read(1024 * 1024):
                    count += len(block)
                    if count > size:
                        raise ValueError("resource exceeds pinned size")
                    digest.update(block)
                    stream.write(block)
        if count != size or digest.hexdigest() != expected:
            raise ValueError("resource differs from pinned release")
        temporary.replace(target)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("resources", type=Path)
    parser.add_argument("--curves-only", action="store_true")
    args = parser.parse_args()
    for name, (_, digest) in PINNED.items():
        if args.curves_only and not name.startswith("models/expression/"):
            continue
        try:
            fetch(args.resources, name)
        except (ValueError, OSError) as error:
            parser.exit(1, f"{name}: {type(error).__name__}; check network and the pinned file\n")
        print(f"{digest}  {name}", flush=True)


if __name__ == "__main__":
    main()
