"""Build a single Python zipapp from the host, SDK and pinned installed dependency."""
from importlib import metadata
from pathlib import Path
from shutil import copy2, copytree, ignore_patterns
from tempfile import TemporaryDirectory
from zipapp import create_archive

import yaml

root = Path(__file__).resolve().parent
requirements = (root / "requirements.txt").read_text(encoding="utf-8").strip()
distribution = metadata.distribution("PyYAML")
if requirements != f"PyYAML=={distribution.version}":
    raise SystemExit(f"Build requires {requirements}")

output = root / "dist" / "kei-host.pyz"
output.parent.mkdir(exist_ok=True)
with TemporaryDirectory(prefix="kei-build-") as temporary:
    staging = Path(temporary)
    for package in ("kei_host", "kei_sdk"):
        copytree(root / package, staging / package, ignore=ignore_patterns("__pycache__"))
    copytree(Path(yaml.__file__).parent, staging / "yaml", ignore=ignore_patterns("__pycache__", "*.pyd", "*.so"))
    licenses = [file for file in distribution.files or () if file.name.upper().startswith("LICENSE")]
    for index, license_file in enumerate(licenses, start=1):
        copy2(distribution.locate_file(license_file), staging / f"PyYAML-LICENSE-{index}.txt")
    copy2(root / "LICENSE", staging / "KEI-LICENSE.txt")
    create_archive(staging, output, main="kei_host.__main__:main", compressed=True)
print(output)
