# neb-core

Pure Rust local photo catalog, metadata and render service. `Core::open(data_dir)` creates a SQLite/WAL database; `dispatch(command, params)` returns the shared JSON contract. Blocking scans and renders must run on the host's blocking worker pool. The catalog mutex is never held while decoding images.

## Implemented behavior

- Local library registration and incremental scanning; stable asset IDs retain rating and crop when metadata changes. Missing/offline assets stay in the catalog. Reconnecting and scanning restores availability. Symbolic links are not followed and source paths are rechecked against the library root on every render.
- SQLite schema v1, foreign keys, WAL, full synchronous commits and FTS5 search over filenames and metadata. Search terms use AND prefix matching; `rating` filters a minimum star rating. Pagination is bounded to 1,000 records.
- EXIF fields, oriented dimensions, file size and modification time. Unsupported and damaged files are catalogued with an explicit decode status instead of fabricated metadata.
- JPEG/PNG/WebP/GIF (first frame)/TIFF/BMP/ICO/PNM display, EXIF orientation applied before edits. RAW metadata and real sensor decoding use a pinned rawloader version. No embedded JPEG is presented as a sensor render.
- Basic RAW development applies active-area cropping, black/white levels, white balance, neighborhood demosaic, camera matrix and sRGB transfer. Preview/histogram rendering demosaics sampled locations at the requested resolution; full RGB frames are reserved for exports. Preview source is `raw_demosaic` or `raster`. Camera support depends on rawloader, and CR3 is explicitly unsupported. This is an initial viewing pipeline, not a professional RAW processor.
- 256-bin RGB and Rec.709 display-luma histogram after orientation and crop, sampled down to at most 2,048 pixels per side. It is not a sensor-linear histogram.
- Normalized non-destructive crop recipes. JPEG exports strip source metadata, create a temporary file beside the destination, sync it and commit without replacing any existing file. Originals are never written by the core.
- `asset.preview` applies the saved crop by default; `uncropped: true` returns the full oriented image for editing an existing recipe. The cache key includes the effective recipe, so cropped and full-frame requests cannot collide.
- Bounded 48-entry / 64 MiB preview memory cache, invalidated by source modification time, file length, preview size and crop recipe.

## Limits and next work

Decoding is bounded to 512 MiB source files and 120 megapixels. Raster allocations use codec limits. A RAW metadata-only pass checks dimensions before sensor decoding. A separate decoder process with OS resource limits is still required for hardened handling of untrusted malformed RAWs. File changes are fingerprinted by nanosecond modification time and size, not by full content hash.

Raster ICC profiles are not transformed; calibrated monitor output, high-quality demosaic, highlight recovery, lens correction and professional RAW color science are future work. HEIC/HEIF/AVIF are identified but not decoded in this build. Disk thumbnail caching, watcher-driven indexing, catalog relinking and background job cancellation belong to subsequent iterations. Local roots support Unicode; non-Unicode Unix paths return explicit errors.

rawloader 0.37.2 is LGPL-2.1. Before binary distribution, the release process must satisfy its license requirements, including notices/source and a compliant relinking arrangement (or change the codec integration). Keep this separate from Nebulume's own source license.

## Tests

`cargo test -p neb-core` covers persistent catalog state and FTS search, incremental metadata changes, ratings/crops, missing/corrupt files, no-overwrite export, immutable originals, exact histogram counts, EXIF orientation before crop, invalid inputs, unsupported formats, and a generated Bayer DNG containing sensor samples but no embedded JPEG. Unix additionally tests symlink traversal boundaries. Synthetic DNG verification does not replace a real-camera corpus across all advertised formats.
