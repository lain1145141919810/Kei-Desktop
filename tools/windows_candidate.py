"""Build and stage a portable Windows candidate without touching its user profile."""

import argparse
from contextlib import contextmanager
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile

REPO = Path(__file__).resolve().parents[1]
MANIFEST = "candidate.json"
LAUNCHER = b'@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0Kei Desktop.exe"\r\n'
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"{prefix}{i}" for prefix in ("COM", "LPT") for i in range(10))}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def build(output, host, revision):
    dist = REPO / "frontend/node_modules/electron/dist"
    if not (dist / "electron.exe").is_file():
        raise ValueError("Install the pinned Windows Electron dependency first")
    commit = subprocess.check_output(["git", "rev-parse", revision], cwd=REPO, text=True).strip()
    tracked = subprocess.check_output(["git", "-c", "core.autocrlf=false", "archive", "--format=zip", commit,
                                       "frontend/src", "frontend/assets", "frontend/package.json"], cwd=REPO)
    hashes = {}
    with ZipFile(output, "x", ZIP_DEFLATED, compresslevel=3) as archive:
        def store(name, data):
            archive.writestr(name, data)
            hashes[name] = digest(data)
        for file in sorted(dist.rglob("*")):
            if not file.is_file():
                continue
            local = file.relative_to(dist).as_posix()
            if local == "resources/default_app.asar":
                continue
            store("Kei Desktop.exe" if local == "electron.exe" else local, file.read_bytes())
        with ZipFile(BytesIO(tracked)) as source:
            for item in source.infolist():
                if not item.is_dir():
                    store("resources/app/" + item.filename.removeprefix("frontend/"), source.read(item))
        store("resources/backend-acceptance/kei-host.pyz", host.read_bytes())
        store("Launch-Kei.cmd", LAUNCHER)
        archive.writestr(MANIFEST, json.dumps({"format": 1, "revision": commit, "sha256": hashes}, indent=2))


def portable_path(name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError("Invalid candidate path")
    relative = PurePosixPath(name)
    if relative.is_absolute() or ".." in relative.parts or relative.as_posix() != name:
        raise ValueError("Invalid candidate path")
    if any(part.endswith((" ", ".")) or part.split(".")[0].upper() in RESERVED
           or any(ord(char) < 32 or char in '<>"|?*' for char in part) for part in relative.parts):
        raise ValueError("Invalid Windows candidate path")
    return relative


def stage(archive, destination):
    with ZipFile(archive) as source:
        entries = source.infolist()
        names = [entry.filename for entry in entries]
        if (len(entries) > 2048 or sum(item.file_size for item in entries) > 1024 ** 3
                or any(item.file_size > 384 * 1024 ** 2 for item in entries)):
            raise ValueError("Candidate archive exceeds the size budget")
        contents = json.loads(source.read(MANIFEST))
        hashes = contents.get("sha256")
        if (contents.get("format") != 1 or not isinstance(hashes, dict) or len(names) != len({name.casefold() for name in names})
                or set(names) != set(hashes) | {MANIFEST} or source.testzip() is not None):
            raise ValueError("Candidate manifest mismatch")
        for name, expected in hashes.items():
            relative = portable_path(name)
            data = source.read(name)
            if digest(data) != expected:
                raise ValueError("Candidate file failed SHA-256 verification")
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        (destination / MANIFEST).write_bytes(source.read(MANIFEST))
    return contents["revision"]


def validate_install_dir(folder):
    if not folder.name or folder.is_symlink():
        raise ValueError("Use a named installation directory")
    folder = folder.resolve()
    if folder.exists() and not (folder / MANIFEST).is_file():
        raise ValueError("The target is not an existing Kei candidate")
    backup = folder.with_name(folder.name + ".previous")
    if backup.is_symlink():
        raise ValueError("Backup target is a symlink")
    return folder, backup


def install(archive, folder):
    folder, backup = validate_install_dir(folder)
    folder.parent.mkdir(parents=True, exist_ok=True)
    if backup.exists():
        raise ValueError("A previous candidate already exists")
    with tempfile.TemporaryDirectory(prefix=".kei-stage-", dir=folder.parent) as staging:
        candidate = Path(staging).resolve()
        if candidate.parent != folder.parent:
            raise ValueError("Candidate staging leaves its installation directory")
        revision = stage(archive, candidate)
        if folder.exists():
            folder.rename(backup)
        try:
            candidate.rename(folder)
        except OSError:
            if backup.exists():
                backup.rename(folder)
            raise
    return revision


def rollback(folder):
    folder, backup = validate_install_dir(folder)
    if not folder.is_dir() or not (backup / MANIFEST).is_file():
        raise ValueError("No previous candidate is available")
    withdrawn = folder.with_name(folder.name + ".withdrawn")
    if withdrawn.exists() or withdrawn.is_symlink():
        raise ValueError("A withdrawn candidate directory already exists")
    folder.rename(withdrawn)
    try:
        backup.rename(folder)
    except OSError:
        withdrawn.rename(folder)
        raise


@contextmanager
def runtime_state(root):
    root = root.resolve(strict=True)
    with (root / ".host.lock").open("a+b") as handle:
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise ValueError("Stop the Kei host before taking or restoring a rollback snapshot") from error
        yield root


def snapshot_plugins(root, snapshot):
    with runtime_state(root) as root:
        sources = [root / "plugins", root / "state.json"]
        if snapshot.parent != root.parent or any(source.is_symlink() for source in sources) or snapshot.exists():
            raise ValueError("Invalid plugin rollback location")
        snapshot.mkdir()
        if sources[0].is_dir():
            shutil.copytree(sources[0], snapshot / "plugins", symlinks=True)
        if sources[1].is_file():
            shutil.copyfile(sources[1], snapshot / "state.json")


def restore_plugins(root, snapshot, withdrawn):
    with runtime_state(root) as root:
        if (snapshot.parent != root.parent or withdrawn.parent != root.parent or len({root, snapshot, withdrawn}) != 3
                or not snapshot.is_dir() or not withdrawn.is_dir()):
            raise ValueError("No matching plugin rollback snapshot")
        for name in ("plugins", "state.json"):
            current = root / name
            previous = snapshot / name
            if current.is_symlink() or previous.is_symlink() or (withdrawn / name).exists():
                raise ValueError("Invalid plugin rollback location")
        changes = []
        try:
            for name in ("plugins", "state.json"):
                current = root / name
                previous = snapshot / name
                retained = withdrawn / name
                if current.exists():
                    current.rename(retained)
                    changes.append((retained, current))
                if previous.exists():
                    previous.rename(current)
                    changes.append((current, previous))
        except OSError:
            for source, target in reversed(changes):
                source.rename(target)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build_cmd = sub.add_parser("build")
    build_cmd.add_argument("output", type=Path)
    build_cmd.add_argument("host", type=Path)
    build_cmd.add_argument("--revision", default="HEAD")
    install_cmd = sub.add_parser("install")
    install_cmd.add_argument("archive", type=Path)
    install_cmd.add_argument("folder", type=Path)
    rollback_cmd = sub.add_parser("rollback")
    rollback_cmd.add_argument("folder", type=Path)
    snapshot_cmd = sub.add_parser("snapshot-plugins")
    snapshot_cmd.add_argument("data", type=Path)
    snapshot_cmd.add_argument("folder", type=Path)
    restore_cmd = sub.add_parser("restore-plugins")
    restore_cmd.add_argument("data", type=Path)
    restore_cmd.add_argument("snapshot", type=Path)
    restore_cmd.add_argument("withdrawn", type=Path)
    args = parser.parse_args()
    if args.command == "build":
        build(args.output, args.host, args.revision)
    elif args.command == "install":
        print(install(args.archive, args.folder))
    elif args.command == "rollback":
        rollback(args.folder)
    elif args.command == "snapshot-plugins":
        snapshot_plugins(args.data, args.folder.resolve())
    else:
        restore_plugins(args.data, args.snapshot.resolve(), args.withdrawn.resolve())


if __name__ == "__main__":
    main()
