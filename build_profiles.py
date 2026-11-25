"""Build minimal and full Windows/Linux backend distribution profiles from the same host."""
import argparse
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

import yaml

BUNDLED = ("pdf", "bilibili", "observation", "focus", "attachments")
ROOT = Path(__file__).resolve().parent


def profile_archive(output, name, host, packages):
    entries = [item for item, _payload in packages]
    manifest = {"profileVersion": 1, "id": name.lower(), "hostSha256": hashlib.sha256(host).hexdigest(), "packages": entries}
    with ZipFile(output / ("Kei-" + name + ".zip"), "x", ZIP_DEFLATED) as archive:
        archive.writestr("profile.json", json.dumps(manifest, indent=2))
        archive.writestr("kei-host.pyz", host)
        archive.write(ROOT / "install_profile.py", "install_profile.py")
        archive.write(ROOT / "docs/installation-profiles.md", "README.md")
        if packages:
            archive.write(ROOT / "requirements-mcp.txt", "requirements-mcp.txt")
        for metadata, payload in packages:
            archive.writestr(metadata["archive"], payload)


def create(output):
    output.mkdir(parents=True, exist_ok=True)
    host = (ROOT / "dist/kei-host.pyz").read_bytes()
    bundles = []
    for name in BUNDLED:
        source = ROOT / "plugins" / name
        metadata = yaml.safe_load((source / "metadata.yaml").read_text("utf-8"))
        with TemporaryDirectory(prefix="kei-bundle-") as temporary:
            package = Path(temporary) / "plugin.zip"
            with ZipFile(package, "x", ZIP_DEFLATED) as archive:
                for file in sorted(source.rglob("*")):
                    if file.is_file() and "__pycache__" not in file.parts:
                        archive.write(file, file.relative_to(source).as_posix())
            payload = package.read_bytes()
        bundles.append(({"id": metadata["id"], "version": metadata["version"], "archive": f"packages/{metadata['id']}.zip",
                         "sha256": hashlib.sha256(payload).hexdigest()}, payload))
    profile_archive(output, "Minimal", host, [])
    profile_archive(output, "Full", host, bundles)


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("output", type=Path)
    create(cli.parse_args().output.resolve())
