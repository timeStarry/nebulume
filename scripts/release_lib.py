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
ALLOWED_IGNORED_TESTS = {
    "credentials::native_test::windows_native_vault_roundtrip_cleans_up_its_entry",
    "watch::live::platform_events_for_a_new_photo_match_the_canonical_root",
    "list_pages_on_a_hundred_thousand_photos",
}


def checked_ignored_tests(count: int, names: object) -> list[str]:
    if (type(count) is not int or count < 0 or not isinstance(names, list)
            or any(not isinstance(name, str) for name in names)
            or len(names) != count or len(set(names)) != count
            or not set(names) <= ALLOWED_IGNORED_TESTS):
        raise ReleaseError("Ignored Rust tests must match the explicit reviewed allowlist and count")
    return sorted(names)


def parse_cargo_ignored(log: str, count: int) -> list[str]:
    names = re.findall(r"^test (\S+) \.\.\. ignored(?:,.*)?\r?$",
                       ANSI_ESCAPE.sub("", log), re.MULTILINE)
    return checked_ignored_tests(count, names)


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


def _clean_filename(value: object, label: str) -> str:
    if not isinstance(value, str) or SAFE_FILENAME.fullmatch(value) is None:
        raise ReleaseError(f"{label} is not a plain file name: {value!r}")
    return value


def _clean_signature(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise ReleaseError(f"{label} must be text")
    cleaned = value.strip()
    if not cleaned or "\n" in cleaned or "\r" in cleaned:
        raise ReleaseError(f"{label} must be a single non-empty line")
    try:
        base64.b64decode(cleaned, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ReleaseError(f"{label} is not valid base64") from error
    return cleaned


def updater_manifest(
    version: str,
    installer_name: str,
    signature: str,
    notes: str,
    pub_date: str,
    repository: str = "timeStarry/lumen",
    macos_updater_name: str | None = None,
    macos_signature: str | None = None,
) -> dict:
    """Build the Tauri updater `latest.json`, refusing anything malformed."""
    if not is_stable_semver(version):
        raise ReleaseError(f"Updater version must be stable semver: {version!r}")
    installer_name = _clean_filename(installer_name, "Installer name")
    signature = _clean_signature(signature, "Updater signature")
    if (macos_updater_name is None) != (macos_signature is None):
        raise ReleaseError("macOS updater archive name and signature must be provided together")
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
    platforms: dict[str, dict[str, str]] = {
        "windows-x86_64": {
            "signature": signature,
            "url": (
                f"https://github.com/{repository}/releases/download/"
                f"v{version}/{installer_name}"
            ),
        }
    }
    if macos_updater_name is not None and macos_signature is not None:
        clean_macos_name = _clean_filename(macos_updater_name, "macOS updater name")
        clean_macos_sig = _clean_signature(macos_signature, "macOS updater signature")
        macos_entry = {
            "signature": clean_macos_sig,
            "url": (
                f"https://github.com/{repository}/releases/download/"
                f"v{version}/{clean_macos_name}"
            ),
        }
        platforms["darwin-aarch64"] = dict(macos_entry)
        platforms["darwin-x86_64"] = dict(macos_entry)
    return {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": platforms,
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


def compare_release_assets(local: dict[str, dict], remote: list[dict]) -> list[str]:
    """List every difference between local upload records and downloaded remote assets.

    `local` maps file name to `{"bytes", "sha256"}`; `remote` holds `gh release view
    --json assets` entries (`name`, `size`) augmented with a downloaded `sha256`.
    """
    problems: list[str] = []
    seen: dict[str, dict] = {}
    for asset in remote:
        name = asset.get("name")
        if name in seen:
            problems.append(f"duplicate remote asset {name!r}")
            continue
        seen[name] = asset
    for name in sorted(local):
        if name not in seen:
            problems.append(f"missing remote asset {name!r}")
            continue
        expected, actual = local[name], seen[name]
        if actual.get("size") != expected["bytes"]:
            problems.append(
                f"size differs for {name!r}: local {expected['bytes']}, remote {actual.get('size')}"
            )
        if actual.get("sha256") != expected["sha256"]:
            problems.append(
                f"sha256 differs for {name!r}: local {expected['sha256']}, remote {actual.get('sha256')}"
            )
    for name in sorted(set(seen) - set(local), key=str):
        problems.append(f"extra remote asset {name!r}")
    return problems
