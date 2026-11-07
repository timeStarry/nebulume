#!/usr/bin/env python3
"""Read a draft GitHub Release back and compare it with the local upload directory."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from release_lib import ReleaseError, compare_release_assets  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReleaseError(message)


def gh(*args: str) -> str:
    process = subprocess.run(["gh", *args], capture_output=True, check=False)
    require(
        process.returncode == 0,
        f"gh {' '.join(args)} failed: {process.stderr.decode('utf-8', 'replace').strip()}",
    )
    return process.stdout.decode("utf-8")


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def local_records(directory: Path) -> dict[str, dict]:
    require(directory.is_dir() and not directory.is_symlink(), f"Output directory is missing: {directory}")
    records = {}
    for path in sorted(directory.iterdir()):
        require(path.is_file() and not path.is_symlink(), f"Non-file member in output directory: {path.name}")
        records[path.name] = {"bytes": path.stat().st_size, "sha256": digest(path)}
    require(bool(records), "Output directory is empty")
    return records


def check_latest_json(directory: Path, names: set[str]) -> list[str]:
    path = directory / "latest.json"
    if not path.is_file():
        return ["downloaded release has no latest.json"]
    try:
        manifest = json.loads(path.read_bytes().decode("utf-8"))
        platform = manifest["platforms"]["windows-x86_64"]
        signature, url = platform["signature"], platform["url"]
    except (ValueError, KeyError, TypeError) as error:
        return [f"latest.json is malformed: {error}"]
    problems = []
    filename = PurePosixPath(unquote(urlparse(url).path)).name if isinstance(url, str) else ""
    if filename not in names:
        problems.append(f"latest.json URL names {filename!r}, which is not a release asset")
    sig_path = directory / f"{filename}.sig"
    if not sig_path.is_file():
        problems.append(f"release lacks the signature file {sig_path.name!r}")
    elif not isinstance(signature, str) or signature != sig_path.read_bytes().decode("ascii", "replace").strip():
        problems.append(f"latest.json signature differs from {sig_path.name!r}")
    return problems


def verify(args: argparse.Namespace) -> list[str]:
    require(re.fullmatch(r"v\d+\.\d+\.\d+", args.tag) is not None, "--tag must look like vX.Y.Z")
    output = Path(args.output_dir).resolve()
    local = local_records(output)
    release = json.loads(gh("release", "view", args.tag, "--json", "tagName,isDraft,assets"))
    problems = []
    if release.get("tagName") != args.tag:
        problems.append(f"release tag is {release.get('tagName')!r}, expected {args.tag!r}")
    if release.get("isDraft") is not True:
        problems.append("release is not a draft; verification is meant to run before publishing")
    remote = [
        {"name": asset.get("name"), "size": asset.get("size")}
        for asset in release.get("assets", [])
    ]
    # Downloads go to a fresh directory so the verified local output is never touched.
    with tempfile.TemporaryDirectory(prefix="nebulume-readback-") as temp:
        download = Path(temp)
        require(download.resolve() != output and not download.resolve().is_relative_to(output),
                "Download directory must be outside the output directory")
        gh("release", "download", args.tag, "--dir", str(download))
        for asset in remote:
            path = download / str(asset["name"])
            if path.is_file() and not path.is_symlink():
                asset["sha256"] = digest(path)
                if path.stat().st_size != asset["size"]:
                    problems.append(f"downloaded size of {asset['name']!r} differs from the API size")
            else:
                problems.append(f"asset {asset['name']!r} was not downloaded")
        problems += compare_release_assets(local, remote)
        problems += check_latest_json(download, {str(asset["name"]) for asset in remote})
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="Release tag, such as v0.2.0")
    parser.add_argument("--output-dir", required=True, help="Local upload directory written by package-release.py")
    args = parser.parse_args()
    try:
        problems = verify(args)
    except (ReleaseError, OSError, ValueError) as error:
        print(f"Release readback failed: {error}", file=sys.stderr)
        return 1
    if problems:
        print("Release readback found mismatches:", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1
    print(f"Release {args.tag} matches {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
