"""Install the packages listed by an isolated Kei distribution profile."""
import argparse
import hashlib
import ipaddress
import json
import re
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise ValueError("Profile requires stable package versions")
    return tuple(map(int, value.split(".")))


def verify_packages(profile):
    bundle = json.loads(profile.read_text("utf-8"))
    if bundle["profileVersion"] != 1:
        raise ValueError("Unsupported profile manifest")
    candidates, ids = [], set()
    for item in bundle["packages"]:
        ident = item["id"]
        if not isinstance(ident, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{1,99}", ident) or ident in ids:
            raise ValueError("Invalid or duplicate profile package ID")
        ids.add(ident)
        source = (profile.parent / item["archive"]).resolve(strict=True)
        if not source.is_relative_to(profile.parent.resolve()) or not source.is_file():
            raise ValueError("Package path leaves the bundle")
        payload = source.read_bytes()
        if hashlib.sha256(payload).hexdigest() != item["sha256"]:
            raise ValueError(f"Package hash mismatch: {item['id']}")
        version(item["version"])
        candidates.append((item, payload))
    return candidates


def install(profile, descriptor, *, upgrade=False):
    candidates = verify_packages(profile)
    connection = json.loads(descriptor.read_text("utf-8"))
    remote = urlsplit(connection["url"])
    if remote.scheme != "http" or not ipaddress.ip_address(remote.hostname).is_loopback or remote.path not in ("", "/"):
        raise ValueError("The host descriptor must point to a local loopback service")

    def send(method, suffix, payload=None):
        headers = {"Authorization": "Bearer " + connection["token"]}
        if payload:
            headers["Content-Type"] = "application/zip"
        request = Request(connection["url"].rstrip("/") + suffix, headers=headers, data=payload, method=method)
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)["data"]
        except HTTPError as error:
            body = json.load(error)
            raise RuntimeError(body["error"]["code"]) from None

    current = {plugin["id"]: plugin for plugin in send("GET", "/v1/plugins")}
    outcomes = []
    for candidate, payload in candidates:
        ident = candidate["id"]
        status = "kept"
        if ident not in current:
            result = send("POST", "/v1/plugins/install", payload)
            if result["id"] != ident or result["version"] != candidate["version"]:
                raise ValueError("Profile does not match its package")
            status = "installed_disabled"
        elif upgrade and version(candidate["version"]) > version(current[ident]["version"]):
            send("POST", "/v1/plugins/" + ident + "/upgrade", payload)
            status = "upgraded"
        outcomes.append({"id": ident, "status": status})
    return outcomes


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", type=Path)
    parser.add_argument("descriptor", type=Path)
    parser.add_argument("--upgrade", action="store_true")
    args = parser.parse_args()
    print(json.dumps(install(args.profile.resolve(), args.descriptor.resolve(), upgrade=args.upgrade), indent=2))
