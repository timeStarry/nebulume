#!/usr/bin/env python3
"""Build the release validation JSON from CI test reports."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from release_lib import (  # noqa: E402
    ReleaseError,
    is_stable_semver,
    parse_cargo_totals,
    parse_cargo_ignored,
    parse_playwright_json,
    parse_vitest_json,
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReleaseError(message)


def read_json(path: Path) -> dict:
    data = json.loads(path.read_bytes().decode("utf-8-sig"))
    require(isinstance(data, dict), f"Report must be a JSON object: {path}")
    return data


def collect(args: argparse.Namespace) -> dict:
    require(is_stable_semver(args.version), "--version must be a stable semantic version")
    require(re.fullmatch(r"[0-9a-f]{40}", args.commit) is not None, "--commit must be a full 40-character SHA")
    cargo_log = Path(args.cargo_log).read_bytes().decode("utf-8", "replace")
    rust_passed, rust_failed, rust_ignored = parse_cargo_totals(cargo_log)
    ignored_names = parse_cargo_ignored(cargo_log, rust_ignored)
    ui_passed, ui_failed = parse_vitest_json(read_json(Path(args.vitest_json)))
    edge_passed, edge_failed = parse_playwright_json(read_json(Path(args.playwright_json)))
    failures = {
        "rust": rust_failed, "ui_unit": ui_failed, "edge_workflows": edge_failed,
    }
    failed = [f"{name}={count}" for name, count in failures.items() if count]
    require(not failed, "Failed tests reported: " + ", ".join(failed))
    # The workflow reaches this step only after these steps have succeeded.
    return {
        "version": args.version,
        "source_commit": args.commit,
        "unsigned": args.unsigned == "true",
        "checks": {
            "rust_passed": rust_passed,
            "rust_ignored": rust_ignored,
            "rust_ignored_tests": ignored_names,
            "ui_unit": ui_passed,
            "edge_workflows": edge_passed,
            "clippy": True,
            "fmt": True,
            "tsc": True,
            "production_build": True,
            "windows_release_and_nsis": True,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True, help="Full HEAD SHA the reports belong to")
    parser.add_argument("--cargo-log", required=True, help="Captured `cargo test` output")
    parser.add_argument("--vitest-json", required=True, help="Vitest --reporter=json output")
    parser.add_argument("--playwright-json", required=True, help="Playwright --reporter=json output")
    parser.add_argument("--unsigned", required=True, choices=("true", "false"))
    parser.add_argument("--output", required=True, help="New validation JSON path (never overwritten)")
    args = parser.parse_args()
    try:
        validation = collect(args)
        output = Path(args.output)
        require(not os.path.lexists(output), "Validation output must not already exist")
        with output.open("xb") as stream:
            stream.write((json.dumps(validation, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    except (ReleaseError, OSError, ValueError) as error:
        print(f"Validation collection failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(validation, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
