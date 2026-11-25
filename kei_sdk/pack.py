"""Package a Kei plugin directory with the manifest and code at ZIP root."""
import argparse
import zipfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if output.is_relative_to(source):
        parser.error("Write the ZIP outside the plugin directory")
    if not all((source / name).is_file() for name in ("metadata.yaml", "main.py")):
        parser.error("Plugin directory requires metadata.yaml and main.py")
    files = sorted(
        file for file in source.rglob("*")
        if file.is_file() and not any(name.startswith(".") or name == "__pycache__" for name in file.relative_to(source).parts)
    )
    if any(file.is_symlink() for file in files):
        parser.error("Plugin archives must contain regular files")
    with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            archive.write(file, file.relative_to(source).as_posix())


if __name__ == "__main__":
    main()
