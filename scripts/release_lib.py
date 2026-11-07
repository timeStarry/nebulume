"""Pure helpers shared by the release scripts: notes, updater manifest, report parsing."""

from __future__ import annotations

import base64
import binascii
from datetime import datetime
import re


STABLE_SEMVER = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")
RFC3339_UTC = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z")
SAFE_FILENAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
CARGO_RESULT = re.compile(
    r"test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored"
)


class ReleaseError(Exception):
    pass


def is_stable_semver(version: object) -> bool:
    return isinstance(version, str) and STABLE_SEMVER.fullmatch(version) is not None


def changelog_notes(text: str, version: str) -> str:
    """Return the body of the `## <version> · YYYY-MM-DD` section, stripped."""
    heading = re.compile(rf"## {re.escape(version)} · \d{{4}}-\d{{2}}-\d{{2}}[ \t]*")
    lines = text.splitlines()
    start = next(
        (index for index, line in enumerate(lines) if heading.fullmatch(line.rstrip())),
        None,
    )
    if start is None:
        raise ReleaseError(f"CHANGELOG has no dated section for {version}")
    body = []
    for line in lines[start + 1:]:
        if line.startswith("## "):
            break
        body.append(line)
    notes = "\n".join(body).strip()
    if not notes:
        raise ReleaseError(f"CHANGELOG section for {version} is empty")
    return notes


def updater_manifest(
    version: str,
    installer_name: str,
    signature: str,
    notes: str,
    pub_date: str,
    repository: str = "timeStarry/nebulume",
) -> dict:
    """Build the Tauri updater `latest.json`, refusing anything malformed."""
    if not is_stable_semver(version):
        raise ReleaseError(f"Updater version must be stable semver: {version!r}")
    if not isinstance(installer_name, str) or SAFE_FILENAME.fullmatch(installer_name) is None:
        raise ReleaseError(f"Installer name is not a plain file name: {installer_name!r}")
    if not isinstance(signature, str):
        raise ReleaseError("Updater signature must be text")
    signature = signature.strip()
    if not signature or "\n" in signature or "\r" in signature:
        raise ReleaseError("Updater signature must be a single non-empty line")
    try:
        base64.b64decode(signature, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ReleaseError("Updater signature is not valid base64") from error
    if not isinstance(notes, str) or not notes.strip():
        raise ReleaseError("Updater notes must be non-empty")
    if not isinstance(pub_date, str) or RFC3339_UTC.fullmatch(pub_date) is None:
        raise ReleaseError(f"pub_date must be RFC 3339 UTC ending in Z: {pub_date!r}")
    try:
        datetime.fromisoformat(pub_date[:19])
    except ValueError as error:
        raise ReleaseError(f"pub_date is not a real time: {pub_date!r}") from error
    if re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+", repository) is None:
        raise ReleaseError(f"Repository must be owner/name: {repository!r}")
    return {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": {
            "windows-x86_64": {
                "signature": signature,
                "url": (
                    f"https://github.com/{repository}/releases/download/"
                    f"v{version}/{installer_name}"
                ),
            }
        },
    }


def parse_cargo_totals(log: str) -> tuple[int, int, int]:
    """Sum passed, failed and ignored over every `test result:` line."""
    results = CARGO_RESULT.findall(ANSI_ESCAPE.sub("", log))
    if not results:
        raise ReleaseError("Cargo log contains no `test result:` lines")
    return tuple(sum(int(item[column]) for item in results) for column in range(3))


def _count(container: object, key: str, label: str) -> int:
    value = container.get(key) if isinstance(container, dict) else None
    if type(value) is not int or value < 0:
        raise ReleaseError(f"{label} report lacks a non-negative integer {key}")
    return value


def parse_vitest_json(data: dict) -> tuple[int, int]:
    """Return `(numPassedTests, numFailedTests)` from a Vitest JSON report."""
    return (
        _count(data, "numPassedTests", "Vitest"),
        _count(data, "numFailedTests", "Vitest"),
    )


def parse_playwright_json(data: dict) -> tuple[int, int]:
    """Return `(expected, unexpected + flaky)` from a Playwright JSON report."""
    stats = data.get("stats") if isinstance(data, dict) else None
    return (
        _count(stats, "expected", "Playwright"),
        _count(stats, "unexpected", "Playwright") + _count(stats, "flaky", "Playwright"),
    )
