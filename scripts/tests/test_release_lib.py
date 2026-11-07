from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from release_lib import (  # noqa: E402
    ReleaseError,
    changelog_notes,
    compare_release_assets,
    parse_cargo_totals,
    parse_playwright_json,
    parse_vitest_json,
    updater_manifest,
)


SAMPLE = """# 更新记录

## 未发布

- 尚未发布的条目。

## 0.1.1 · 2026-10-19

- 修复 A。
- 修复 B。

## 0.1.0 · 2026-10-17

首个版本。
"""


class ChangelogNotesTest(unittest.TestCase):
    def test_changelog_notes_extracts_section(self) -> None:
        self.assertEqual(changelog_notes(SAMPLE, "0.1.1"), "- 修复 A。\n- 修复 B。")
        self.assertEqual(changelog_notes(SAMPLE, "0.1.0"), "首个版本。")
        with self.assertRaises(ReleaseError):
            changelog_notes(SAMPLE, "0.2.0")

    def test_changelog_notes_rejects_unreleased_and_empty(self) -> None:
        with self.assertRaises(ReleaseError):
            changelog_notes(SAMPLE, "未发布")
        with self.assertRaises(ReleaseError):
            changelog_notes("## 0.3.0 · 2026-11-07\n\n## 0.2.0 · 2026-11-01\n- x\n", "0.3.0")
        with self.assertRaises(ReleaseError):
            changelog_notes("## 0.1.10 · 2026-11-07\n- x\n", "0.1.1")

    def test_changelog_notes_on_repository_changelog(self) -> None:
        text = (Path(__file__).resolve().parents[2] / "CHANGELOG.md").read_text(encoding="utf-8")
        self.assertIn("RAW", changelog_notes(text, "0.1.1"))


class UpdaterManifestTest(unittest.TestCase):
    ARGS = {
        "version": "0.2.0",
        "installer_name": "Nebulume_0.2.0_x64-setup.exe",
        "signature": "dW50cnVzdGVk",
        "notes": "- 新功能。",
        "pub_date": "2026-11-07T00:00:00Z",
    }

    def test_updater_manifest_shape(self) -> None:
        manifest = updater_manifest(**self.ARGS)
        self.assertEqual(
            manifest,
            {
                "version": "0.2.0",
                "notes": "- 新功能。",
                "pub_date": "2026-11-07T00:00:00Z",
                "platforms": {
                    "windows-x86_64": {
                        "signature": "dW50cnVzdGVk",
                        "url": "https://github.com/timeStarry/nebulume/releases/download/v0.2.0/Nebulume_0.2.0_x64-setup.exe",
                    }
                },
            },
        )
        self.assertEqual(list(manifest["platforms"]), ["windows-x86_64"])

    def test_updater_manifest_strips_trailing_newline(self) -> None:
        manifest = updater_manifest(**{**self.ARGS, "signature": "dW50cnVzdGVk\n"})
        self.assertEqual(manifest["platforms"]["windows-x86_64"]["signature"], "dW50cnVzdGVk")

    def test_updater_manifest_rejects_bad_input(self) -> None:
        for override in (
            {"version": "v0.2"},
            {"version": "0.2.0-beta.1"},
            {"signature": ""},
            {"signature": "  \n"},
            {"signature": "a\nb"},
            {"signature": "not base64!"},
            {"pub_date": "2026-11-07"},
            {"pub_date": "2026-11-07T00:00:00+08:00"},
            {"pub_date": "2026-13-07T00:00:00Z"},
            {"installer_name": "../evil.exe"},
            {"notes": " "},
        ):
            with self.subTest(override=override), self.assertRaises(ReleaseError):
                updater_manifest(**{**self.ARGS, **override})


class ReportParsingTest(unittest.TestCase):
    def test_parse_cargo_totals_sums_all_binaries(self) -> None:
        log = (
            "running 4 tests\n"
            "test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s\n"
            "\x1b[32mtest result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out\x1b[0m\n"
        )
        self.assertEqual(parse_cargo_totals(log), (6, 0, 2))
        self.assertEqual(
            parse_cargo_totals("test result: FAILED. 2 passed; 1 failed; 0 ignored;"),
            (2, 1, 0),
        )
        with self.assertRaises(ReleaseError):
            parse_cargo_totals("error: could not compile")

    def test_parse_reporters(self) -> None:
        self.assertEqual(parse_vitest_json({"numPassedTests": 70, "numFailedTests": 0}), (70, 0))
        self.assertEqual(
            parse_playwright_json({"stats": {"expected": 68, "unexpected": 1, "flaky": 2, "skipped": 0}}),
            (68, 3),
        )
        with self.assertRaises(ReleaseError):
            parse_vitest_json({"numPassedTests": "70", "numFailedTests": 0})
        with self.assertRaises(ReleaseError):
            parse_playwright_json({"stats": {"expected": 68}})


def load_script(name: str):
    import importlib.util

    path = Path(__file__).resolve().parents[1] / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_").removesuffix(".py"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CompareReleaseAssetsTest(unittest.TestCase):
    def test_compare_release_assets_reports_each_mismatch(self) -> None:
        local = {"a": {"bytes": 1, "sha256": "x"}, "b": {"bytes": 2, "sha256": "y"}}
        remote = [
            {"name": "a", "size": 1, "sha256": "x"},
            {"name": "b", "size": 3, "sha256": "y"},
            {"name": "c", "size": 1, "sha256": "z"},
        ]
        problems = compare_release_assets(local, remote)
        self.assertEqual(len(problems), 2)
        self.assertTrue(any("b" in item and "size" in item for item in problems))
        self.assertTrue(any("c" in item and "extra" in item for item in problems))
        self.assertFalse(any("'a'" in item for item in problems))
        missing = compare_release_assets(local, remote[:1])
        self.assertEqual(missing, ["missing remote asset 'b'"])
        digest = compare_release_assets(local, [remote[0], {"name": "b", "size": 2, "sha256": "w"}])
        self.assertEqual(len(digest), 1)
        self.assertIn("sha256", digest[0])
        identical = [{"name": "a", "size": 1, "sha256": "x"}, {"name": "b", "size": 2, "sha256": "y"}]
        self.assertEqual(compare_release_assets(local, identical), [])


class PackageReleaseTest(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        self.package = load_script("package-release.py")
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_shares_release_error(self) -> None:
        self.assertIs(self.package.ReleaseError, ReleaseError)

    def test_latest_json_round_trips_and_refuses_malformed(self) -> None:
        import json

        content = self.package.latest_json(
            "0.2.0", "Nebulume_0.2.0_x64-setup.exe", "dW50cnVzdGVk", "- x", "2026-11-07T00:00:00Z"
        )
        path = self.dir / "latest.json"
        self.package.exclusive_write(path, content)
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["platforms"]["windows-x86_64"]["signature"], "dW50cnVzdGVk")
        with self.assertRaises(FileExistsError):
            self.package.exclusive_write(path, content)
        with self.assertRaises(ReleaseError):
            self.package.latest_json("0.2.0", "Nebulume_0.2.0_x64-setup.exe", "", "- x", "2026-11-07T00:00:00Z")

    def test_read_signature_requirements(self) -> None:
        import os

        sig = self.dir / "Nebulume_0.2.0_x64-setup.exe.sig"
        sig.write_bytes(b"dW50cnVzdGVk\n")
        mtime = sig.stat().st_mtime_ns
        text, record = self.package.read_signature(sig, mtime)
        self.assertEqual(text, "dW50cnVzdGVk")
        self.assertEqual(record["bytes"], 13)
        with self.assertRaises(ReleaseError):
            self.package.read_signature(sig, mtime + 1)
        with self.assertRaises(ReleaseError):
            self.package.read_signature(self.dir / "missing.sig", 0)
        sig.write_bytes(b"line1\nline2\n")
        with self.assertRaises(ReleaseError):
            self.package.read_signature(sig, 0)
        link = self.dir / "link.sig"
        os.symlink(sig, link)
        with self.assertRaises(ReleaseError):
            self.package.read_signature(link, 0)


class CollectValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        self.collect = load_script("collect-validation.py")
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def args(self, cargo: str, vitest_failed: int = 0):
        import argparse
        import json

        (self.dir / "cargo.log").write_text(cargo, encoding="utf-8")
        (self.dir / "vitest.json").write_text(
            json.dumps({"numPassedTests": 70, "numFailedTests": vitest_failed}), encoding="utf-8"
        )
        (self.dir / "pw.json").write_text(
            json.dumps({"stats": {"expected": 68, "unexpected": 0, "flaky": 0}}), encoding="utf-8"
        )
        return argparse.Namespace(
            version="0.2.0", commit="a" * 40, cargo_log=str(self.dir / "cargo.log"),
            vitest_json=str(self.dir / "vitest.json"), playwright_json=str(self.dir / "pw.json"),
            unsigned="true", output=str(self.dir / "out.json"),
        )

    def test_output_is_accepted_by_package_release(self) -> None:
        import json

        validation = self.collect.collect(
            self.args("test result: ok. 212 passed; 0 failed; 1 ignored; 0 measured\n")
        )
        path = self.dir / "validation.json"
        path.write_text(json.dumps(validation), encoding="utf-8")
        package = load_script("package-release.py")
        selected, _ = package.read_validation(path, "0.2.0", "a" * 40)
        self.assertEqual(selected["checks"]["rust_passed"], 212)
        self.assertTrue(selected["unsigned"])

    def test_failed_counts_refused(self) -> None:
        with self.assertRaises(ReleaseError):
            self.collect.collect(self.args("test result: FAILED. 211 passed; 1 failed; 1 ignored;\n"))
        with self.assertRaises(ReleaseError):
            self.collect.collect(self.args("test result: ok. 212 passed; 0 failed; 1 ignored;\n", 1))
