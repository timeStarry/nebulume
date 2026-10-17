#!/usr/bin/env python3
"""Package verified Windows release artifacts without reading application data."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tomllib
from typing import BinaryIO
import zipfile


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_PACKAGES = {
    "neb-app", "neb-cli", "neb-core", "neb-ingest", "neb-service", "neb-storage"
}
MINIMUM_COUNTS = {"rust_passed": 212, "ui_unit": 62, "edge_workflows": 68}
PASSING_CHECKS = (
    "clippy", "fmt", "tsc", "production_build", "windows_release_and_nsis"
)
ROOT_INPUTS = {
    "Cargo.toml", "Cargo.lock", "package.json", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "rust-toolchain", "rust-toolchain.toml",
}


class ReleaseError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReleaseError(message)


def git(*args: str) -> bytes:
    process = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, check=False
    )
    require(process.returncode == 0, f"Git command failed: {' '.join(args)}")
    return process.stdout


def git_text(*args: str) -> str:
    return git(*args).decode("utf-8").strip()


def git_paths(*args: str) -> list[str]:
    return [item.decode("utf-8", "surrogateescape") for item in git(*args).split(b"\0") if item]


def source_identity() -> dict[str, str]:
    require(
        Path(git_text("rev-parse", "--show-toplevel")).resolve() == ROOT,
        "The packaging script must run from its own Git repository",
    )
    return {
        "commit": git_text("rev-parse", "HEAD"),
        "tree": git_text("rev-parse", "HEAD^{tree}"),
    }


def assert_clean() -> None:
    for args in (
        ("diff", "--quiet", "--ignore-submodules=none", "--"),
        ("diff", "--cached", "--quiet", "--ignore-submodules=none", "HEAD", "--"),
    ):
        process = subprocess.run(
            ["git", *args], cwd=ROOT, capture_output=True, check=False,
        )
        require(
            process.returncode == 0,
            "Tracked or staged changes exist; commit the complete release before packaging",
        )
    unexpected = [
        path for path in git_paths("ls-files", "--others", "--exclude-standard", "-z")
        if path in ROOT_INPUTS
        or PurePosixPath(path).parts[0] in {"crates", "packages", ".cargo"}
    ]
    require(
        not unexpected,
        "Untracked files exist in production source areas: " + ", ".join(unexpected),
    )


def is_build_input(name: str) -> bool:
    path = PurePosixPath(name)
    if name in ROOT_INPUTS or path.parts[0] == ".cargo":
        return True
    if path.parts[0] not in {"crates", "packages"}:
        return False
    if any(part in {"tests", "benches"} for part in path.parts):
        return False
    if path.suffix.lower() == ".md" or path.name in {".gitignore", "playwright.config.ts"}:
        return False
    return True


def stream_digest(stream: BinaryIO) -> str:
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(chunk)
    return value.hexdigest()


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return stream_digest(stream)


def info(path: Path) -> dict[str, int | str]:
    return {"bytes": path.stat().st_size, "sha256": digest(path)}


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def checksums(files: dict[str, dict[str, int | str]]) -> bytes:
    return "".join(
        f"{record['sha256']}  {name}\n" for name, record in sorted(files.items())
    ).encode("utf-8")


def exclusive_write(path: Path, content: bytes) -> None:
    with path.open("xb") as stream:
        stream.write(content)


def check_versions(version: str, tracked: set[str]) -> None:
    required = {
        "Cargo.toml", "Cargo.lock", "package.json", "packages/ui/package.json",
        "crates/neb-app/tauri.conf.json",
    }
    require(required <= tracked, "All version manifests and lock files must be tracked")
    with (ROOT / "Cargo.toml").open("rb") as stream:
        cargo = tomllib.load(stream)
    require(cargo["workspace"]["package"]["version"] == version, "Cargo workspace version differs")
    for name in ("package.json", "packages/ui/package.json", "crates/neb-app/tauri.conf.json"):
        data = json.loads((ROOT / name).read_text(encoding="utf-8-sig"))
        require(data.get("version") == version, f"Version differs in {name}")
    with (ROOT / "Cargo.lock").open("rb") as stream:
        packages = tomllib.load(stream)["package"]
    workspace = [entry for entry in packages if entry["name"] in WORKSPACE_PACKAGES]
    require(
        len(workspace) == len(WORKSPACE_PACKAGES)
        and {entry["name"] for entry in workspace} == WORKSPACE_PACKAGES,
        "Cargo.lock must contain exactly the six workspace packages",
    )
    require(
        all(entry["version"] == version and "source" not in entry for entry in workspace),
        "Cargo.lock workspace package versions differ or reference external sources",
    )


def read_validation(path: Path, version: str, commit: str) -> tuple[dict, str]:
    raw = path.read_bytes()
    validation = json.loads(raw.decode("utf-8-sig"))
    require(isinstance(validation, dict), "Validation must be a JSON object")
    require(validation.get("version") == version, "Validation version differs")
    require(validation.get("source_commit") == commit, "Validation commit differs from HEAD")
    provided = validation.get("checks")
    require(isinstance(provided, dict), "Validation checks are required")
    selected = {}
    for name, minimum in MINIMUM_COUNTS.items():
        actual = provided.get(name)
        require(type(actual) is int and actual >= minimum, f"Validation {name} must be at least {minimum}")
        selected[name] = actual
    require(
        type(provided.get("rust_ignored")) is int and provided["rust_ignored"] == 1,
        "The single explicitly ignored native-credential test must be recorded",
    )
    selected["rust_ignored"] = provided["rust_ignored"]
    for name in PASSING_CHECKS:
        require(provided.get(name) is True, f"Validation {name} must be true")
        selected[name] = True
    require(type(validation.get("unsigned")) is bool, "Validation must explicitly record unsigned: true or false")
    return {"checks": selected, "unsigned": validation["unsigned"]}, hashlib.sha256(raw).hexdigest()


def source_inputs(tracked: set[str]) -> dict[str, dict[str, int | str]]:
    names = sorted(name for name in tracked if is_build_input(name))
    require(bool(names), "No tracked production build inputs found")
    result = {}
    for name in names:
        path = ROOT / name
        require(path.is_file() and not path.is_symlink(), f"Build input is absent or a symlink: {name}")
        result[name] = {"mtime_ns": path.stat().st_mtime_ns, "sha256": digest(path)}
    return result


def check_executable(path: Path, newest_input: int) -> dict[str, int | str]:
    require(path.is_file() and not path.is_symlink(), f"Missing regular Windows artifact: {path}")
    require(path.stat().st_mtime_ns >= newest_input, f"Artifact predates tracked production inputs: {path}")
    with path.open("rb") as stream:
        require(stream.read(2) == b"MZ", f"Artifact lacks the Windows MZ header: {path}")
    return info(path)


def resolve_path(value: str) -> Path:
    path = Path(value)
    return (ROOT / path).resolve() if not path.is_absolute() else path.resolve()


def package(args: argparse.Namespace) -> dict:
    require(
        re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", args.version) is not None,
        "--version must be a stable semantic version such as 0.1.0",
    )
    assert_clean()
    identity = source_identity()
    identity["tag"] = f"v{args.version}"
    # An existing release tag is acceptable only when it identifies this exact commit.
    tag = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"refs/tags/{identity['tag']}^{{commit}}"],
        cwd=ROOT, capture_output=True, check=False,
    )
    require(
        tag.returncode == 1
        or (tag.returncode == 0 and tag.stdout.decode("ascii").strip() == identity["commit"]),
        "The existing release tag does not identify HEAD",
    )
    tracked = set(git_paths("ls-files", "-z"))
    check_versions(args.version, tracked)
    validation_path = resolve_path(args.validation)
    verification, validation_sha = read_validation(validation_path, args.version, identity["commit"])
    inputs = source_inputs(tracked)
    newest_input = max(int(value["mtime_ns"]) for value in inputs.values())
    inputs_sha = hashlib.sha256(
        "".join(f"{name}\0{record['sha256']}\n" for name, record in inputs.items()).encode("utf-8")
    ).hexdigest()
    target = resolve_path(args.target_dir) / "release"
    exe_source = target / "nebulume.exe"
    installer_name = f"Nebulume_{args.version}_x64-setup.exe"
    installer_source = target / "bundle/nsis" / installer_name
    exe_record = check_executable(exe_source, newest_input)
    installer_record = check_executable(installer_source, newest_input)
    raw_output = Path(args.output_dir)
    if not raw_output.is_absolute():
        raw_output = ROOT / raw_output
    require(not os.path.lexists(raw_output), "Output directory must be new, including no existing symlink")
    output = raw_output.resolve()
    require(not os.path.lexists(output), "Output directory must be new; existing output is never overwritten")
    require(
        not validation_path.is_relative_to(output)
        and not exe_source.is_relative_to(output)
        and not installer_source.is_relative_to(output),
        "Output must not contain source artifacts or the validation input",
    )
    archive_name = f"Nebulume_{args.version}_windows_x64.zip"
    names = {installer_name, archive_name, "manifest.json", "SHA256SUMS.txt"}
    created = datetime.now(timezone.utc).isoformat()
    runtime = {
        "schema_version": 1,
        "product": "Nebulume",
        "version": args.version,
        "platform": "windows-x86_64",
        "source": identity,
        "unsigned": verification["unsigned"],
        "application": {"filename": "nebulume.exe", **exe_record},
        "data_storage": "system_application_data_directory",
        "requirements": ["Microsoft Edge WebView2 Runtime"],
    }
    readme = (
        f"Nebulume {args.version} · Windows x64\n\n"
        "解压后运行 nebulume.exe；需要 Microsoft Edge WebView2 Runtime。\n"
        "独立程序仍使用系统应用数据目录保存图库索引、设置和缓存，"
        "不会将用户数据保存在本 ZIP 内，也不是随程序目录携带数据的便携数据模式。\n"
        "原片默认只读；导入保留来源，裁剪保存配方，导出生成新文件。\n"
        "本包不含用户数据库、照片、连接配置、凭据或测试日志。\n"
        f"源码标签：{identity['tag']}\n提交：{identity['commit']}\n"
        f"Windows 代码签名：{'未签名' if verification['unsigned'] else '已签名（见发布验证）'}\n"
        "下载与更新：https://github.com/timeStarry/nebulume/releases\n"
        "SHA256SUMS.txt 用于核对本包成员；完整发布说明与已知限制见 Release。\n"
    ).encode("utf-8")
    contents = {"README.txt": readme, "manifest.json": json_bytes(runtime)}
    member_records = {
        "nebulume.exe": exe_record,
        **{
            name: {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            for name, content in contents.items()
        },
    }
    contents["SHA256SUMS.txt"] = checksums(member_records)
    expected_members = {
        **member_records,
        "SHA256SUMS.txt": {
            "bytes": len(contents["SHA256SUMS.txt"]),
            "sha256": hashlib.sha256(contents["SHA256SUMS.txt"]).hexdigest(),
        },
    }

    # All preconditions precede output creation. Failures leave evidence for inspection;
    # this script never deletes partial output or reuses an existing directory.
    output.mkdir(parents=True, exist_ok=False)
    installer = output / installer_name
    with installer_source.open("rb") as source, installer.open("xb") as destination:
        shutil.copyfileobj(source, destination, length=1024 * 1024)
    require(info(installer) == installer_record == info(installer_source), "Installer changed during copy")
    archive = output / archive_name
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        bundle.write(exe_source, "nebulume.exe")
        for name, content in sorted(contents.items()):
            bundle.writestr(name, content)
    with zipfile.ZipFile(archive) as bundle:
        require(bundle.testzip() is None, "ZIP CRC verification failed")
        members = bundle.namelist()
        require(
            len(members) == len(expected_members) and set(members) == set(expected_members),
            "ZIP member whitelist differs",
        )
        for name, record in expected_members.items():
            require(bundle.getinfo(name).file_size == record["bytes"], f"ZIP member size differs: {name}")
            with bundle.open(name) as stream:
                require(stream_digest(stream) == record["sha256"], f"ZIP member hash differs: {name}")
    require(info(exe_source) == exe_record, "Application changed during ZIP creation")
    archive_record = info(archive)
    manifest = {
        "schema_version": 1,
        "product": "Nebulume",
        "version": args.version,
        "platform": "windows-x86_64",
        "created_utc": created,
        "source": identity,
        "source_inputs": {"files": len(inputs), "sha256": inputs_sha},
        "validation_sha256": validation_sha,
        "checks": verification["checks"],
        "unsigned": verification["unsigned"],
        "artifacts": {
            "application": {"archive_member": "nebulume.exe", **exe_record},
            "installer": {"filename": installer_name, **installer_record},
            "portable_archive": {"filename": archive_name, **archive_record},
        },
        "not_verified": ["installation_and_uninstallation", "macos_linux_release_acceptance"],
    }
    exclusive_write(output / "manifest.json", json_bytes(manifest))
    upload_records = {
        installer_name: installer_record,
        archive_name: archive_record,
        "manifest.json": info(output / "manifest.json"),
    }
    sums = checksums(upload_records)
    exclusive_write(output / "SHA256SUMS.txt", sums)
    require({path.name for path in output.iterdir()} == names, "Upload directory whitelist differs")
    require(all(path.is_file() and not path.is_symlink() for path in output.iterdir()), "Non-file release member")
    for name, record in upload_records.items():
        require(info(output / name) == record, f"Final upload artifact changed: {name}")
    require((output / "SHA256SUMS.txt").read_bytes() == sums, "Final checksum list changed")
    require(info(installer_source) == installer_record, "Installer source changed while packaging")
    require(info(exe_source) == exe_record, "Application source changed while packaging")
    require(digest(validation_path) == validation_sha, "Validation changed while packaging")
    assert_clean()
    require(source_identity() == {key: identity[key] for key in ("commit", "tree")}, "HEAD changed while packaging")
    require(source_inputs(tracked) == inputs, "Production inputs changed while packaging")
    return {
        "verified": True,
        "output_directory": str(output),
        "version": args.version,
        "source": identity,
        "unsigned": verification["unsigned"],
        "zip_crc_verified": True,
        "zip_member_sha256_verified": True,
        "upload_whitelist_verified": True,
        "upload_files": {**upload_records, "SHA256SUMS.txt": info(output / "SHA256SUMS.txt")},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--target-dir", required=True, help="Cargo target directory, relative to repository root")
    parser.add_argument("--output-dir", required=True, help="New, never previously created upload directory")
    parser.add_argument("--validation", required=True, help="Validation JSON for the exact HEAD and version")
    args = parser.parse_args()
    try:
        result = package(args)
    except (ReleaseError, OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"Release packaging failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
