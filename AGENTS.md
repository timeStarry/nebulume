# Nebulume working agreement

- Build a cross-platform, local-first photo catalog. Rust owns filesystem, credentials, storage, codecs, index and import safety; SolidJS owns interaction; Tauri and CLI call the same command service.
- Original files are immutable by default. Crops are recipes; exports are new files. An import never deletes the source and never overwrites unrelated destination content.
- Library metadata is SQLite; credentials must not appear in the database, logs, git or UI responses. Remote access is explicit.
- Keep modules independently testable. Test failure and recovery paths for imports and storage, coordinate API changes in docs/API.md.
- Mark unsupported codecs and unavailable connections honestly. Do not fabricate metadata or silently substitute demonstration data in production.
- Document decisions and actual validation in docs. Cross-platform claims require CI evidence; a Windows build alone is insufficient.
- Other agents may edit this repository concurrently. Preserve their edits and respect assigned ownership.
