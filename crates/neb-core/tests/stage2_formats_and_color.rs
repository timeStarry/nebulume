use std::{
    fs,
    io::Cursor,
};

use image::{
    codecs::jpeg::{JpegDecoder, JpegEncoder},
    ImageDecoder, Rgb, RgbImage,
};
use neb_core::{capture_time, remote_preview, Core, PreviewTier};
use serde_json::json;

fn bmff_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = (8 + payload.len()) as u32;
    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

fn uuid_box(uuid: &[u8; 16], payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(16 + payload.len());
    body.extend_from_slice(uuid);
    body.extend_from_slice(payload);
    bmff_box(b"uuid", &body)
}

fn single_ifd_tiff(entries: &[(u16, u16, u32, &[u8])]) -> Vec<u8> {
    let mut sorted = entries.to_vec();
    sorted.sort_by_key(|e| e.0);
    let dir_end = 8 + 2 + sorted.len() * 12 + 4;
    let mut out = vec![0_u8; dir_end];
    out[0..4].copy_from_slice(b"II\x2a\x00");
    out[4..8].copy_from_slice(&8_u32.to_le_bytes());
    out[8..10].copy_from_slice(&(sorted.len() as u16).to_le_bytes());
    for (idx, (tag, kind, count, data)) in sorted.iter().enumerate() {
        let pos = 10 + idx * 12;
        out[pos..pos + 2].copy_from_slice(&tag.to_le_bytes());
        out[pos + 2..pos + 4].copy_from_slice(&kind.to_le_bytes());
        out[pos + 4..pos + 8].copy_from_slice(&count.to_le_bytes());
        if data.len() <= 4 {
            out[pos + 8..pos + 8 + data.len()].copy_from_slice(data);
        } else {
            let offset = out.len() as u32;
            out[pos + 8..pos + 12].copy_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(data);
            if !out.len().is_multiple_of(2) {
                out.push(0);
            }
        }
    }
    out
}

fn encode_jpeg(width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut buf, 90)
        .encode_image(&RgbImage::from_pixel(width, height, Rgb(color)))
        .unwrap();
    buf.into_inner()
}

fn build_synthetic_cr3() -> Vec<u8> {
    let canon_meta_uuid: [u8; 16] = [
        0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a,
        0x48,
    ];
    let canon_preview_uuid: [u8; 16] = [
        0xea, 0xf4, 0x2b, 0x5e, 0x1c, 0x98, 0x4b, 0x88, 0xb9, 0xfb, 0xb7, 0xdc, 0x40, 0x6e, 0x4d,
        0x16,
    ];

    let cmt1 = single_ifd_tiff(&[
        (0x010f, 2, 6, b"Canon\0"),
        (0x0110, 2, 13, b"Canon EOS R5\0"),
        (0x0112, 3, 1, &6_u16.to_le_bytes()), // Orientation = Rotate90 CW
    ]);
    let mut exposure = [0_u8; 8];
    exposure[0..4].copy_from_slice(&1_u32.to_le_bytes());
    exposure[4..8].copy_from_slice(&250_u32.to_le_bytes());
    let mut fnumber = [0_u8; 8];
    fnumber[0..4].copy_from_slice(&28_u32.to_le_bytes());
    fnumber[4..8].copy_from_slice(&10_u32.to_le_bytes());
    let mut focal = [0_u8; 8];
    focal[0..4].copy_from_slice(&50_u32.to_le_bytes());
    focal[4..8].copy_from_slice(&1_u32.to_le_bytes());
    let cmt2 = single_ifd_tiff(&[
        (0x829a, 5, 1, &exposure),
        (0x829d, 5, 1, &fnumber),
        (0x8827, 3, 1, &400_u16.to_le_bytes()),
        (0x9003, 2, 20, b"2026:11:12 09:15:30\0"),
        (0x9011, 2, 7, b"+08:00\0"),
        (0x920a, 5, 1, &focal),
        (0x9291, 2, 4, b"450\0"),
        (0xa001, 3, 1, &2_u16.to_le_bytes()), // ColorSpace = 2 (Adobe RGB)
        (0xa434, 2, 24, b"RF24-70mm F2.8 L IS USM\0"),
    ]);

    let thumb_jpeg = encode_jpeg(160, 120, [40, 80, 120]);
    let mut thmb_payload = Vec::new();
    thmb_payload.extend_from_slice(&0_u32.to_be_bytes());
    thmb_payload.extend_from_slice(&160_u16.to_be_bytes());
    thmb_payload.extend_from_slice(&120_u16.to_be_bytes());
    thmb_payload.extend_from_slice(&(thumb_jpeg.len() as u32).to_be_bytes());
    thmb_payload.extend_from_slice(&0_u32.to_be_bytes());
    thmb_payload.extend_from_slice(&thumb_jpeg);

    let full_jpeg = encode_jpeg(600, 400, [210, 95, 55]);
    let prvw_jpeg = encode_jpeg(300, 200, [100, 100, 100]);

    // Build `ftyp` + `moov` with placeholder `stco` offset, then patch exact `mdat` offset.
    let ftyp = bmff_box(b"ftyp", b"crx \0\0\0\x01crx isom");

    let mut meta_children = Vec::new();
    meta_children.extend_from_slice(&bmff_box(b"CMT1", &cmt1));
    meta_children.extend_from_slice(&bmff_box(b"CMT2", &cmt2));
    meta_children.extend_from_slice(&bmff_box(b"THMB", &thmb_payload));
    let meta_uuid = uuid_box(&canon_meta_uuid, &meta_children);

    let mut stsz = Vec::new();
    stsz.extend_from_slice(&0_u32.to_be_bytes());
    stsz.extend_from_slice(&(full_jpeg.len() as u32).to_be_bytes());
    stsz.extend_from_slice(&1_u32.to_be_bytes());
    let stsz_box = bmff_box(b"stsz", &stsz);

    let mut stco = Vec::new();
    stco.extend_from_slice(&0_u32.to_be_bytes());
    stco.extend_from_slice(&1_u32.to_be_bytes());
    stco.extend_from_slice(&0xDEAD_BEEF_u32.to_be_bytes());
    let stco_box = bmff_box(b"stco", &stco);

    let mut stbl_children = Vec::new();
    stbl_children.extend_from_slice(&stsz_box);
    stbl_children.extend_from_slice(&stco_box);
    let stbl = bmff_box(b"stbl", &stbl_children);
    let minf = bmff_box(b"minf", &stbl);
    let mdia = bmff_box(b"mdia", &minf);
    let trak = bmff_box(b"trak", &mdia);

    let mut moov_children = Vec::new();
    moov_children.extend_from_slice(&meta_uuid);
    moov_children.extend_from_slice(&trak);
    let moov = bmff_box(b"moov", &moov_children);

    let mut prvw_payload = Vec::new();
    prvw_payload.extend_from_slice(&0_u32.to_be_bytes());
    prvw_payload.extend_from_slice(&0_u16.to_be_bytes());
    prvw_payload.extend_from_slice(&300_u16.to_be_bytes());
    prvw_payload.extend_from_slice(&200_u16.to_be_bytes());
    prvw_payload.extend_from_slice(&0_u16.to_be_bytes());
    prvw_payload.extend_from_slice(&(prvw_jpeg.len() as u32).to_be_bytes());
    prvw_payload.extend_from_slice(&prvw_jpeg);
    let prvw_uuid = uuid_box(&canon_preview_uuid, &bmff_box(b"PRVW", &prvw_payload));

    let mut mdat_payload = Vec::new();
    mdat_payload.extend_from_slice(&full_jpeg);
    // Simulate trailing CRX raw slice payload that must never be read during metadata/preview!
    mdat_payload.extend_from_slice(&vec![0xaa_u8; 64 * 1024]);
    let mdat = bmff_box(b"mdat", &mdat_payload);

    let mut file = Vec::new();
    file.extend_from_slice(&ftyp);
    file.extend_from_slice(&moov);
    file.extend_from_slice(&prvw_uuid);
    let full_jpeg_offset = (file.len() + 8) as u32; // right after 8-byte `mdat` header
    file.extend_from_slice(&mdat);

    let marker = 0xDEAD_BEEF_u32.to_be_bytes();
    let patch_pos = file
        .windows(4)
        .position(|w| w == marker)
        .expect("placeholder stco offset");
    file[patch_pos..patch_pos + 4].copy_from_slice(&full_jpeg_offset.to_be_bytes());
    file
}

fn decoded_icc(jpeg: &[u8]) -> Option<Vec<u8>> {
    JpegDecoder::new(Cursor::new(jpeg))
        .unwrap()
        .icc_profile()
        .unwrap()
}

#[test]
fn canon_cr3_indexes_exif_capture_time_full_preview_and_adobe_rgb_icc() {
    let temp = tempfile::tempdir().unwrap();
    let photos = temp.path().join("photos");
    fs::create_dir_all(&photos).unwrap();
    let cr3_bytes = build_synthetic_cr3();
    let cr3_path = photos.join("_MG_1001.CR3");
    fs::write(&cr3_path, &cr3_bytes).unwrap();

    // Bounded capture-time parser reads CMT2 DateTimeOriginal directly.
    let cap = capture_time::read_path(&cr3_path).unwrap();
    assert_eq!(cap.captured_at, "2026-11-12T09:15:30.450000000");
    assert_eq!(
        cap.metadata.get("Capture Time Zone").map(String::as_str),
        Some("+08:00")
    );

    let core = Core::open(temp.path().join("catalog.sqlite")).unwrap();
    let lib = core.add_library("Canon R5", &photos).unwrap();
    let scan = core
        .dispatch("library.scan", json!({"library_id": lib.id}))
        .unwrap();
    assert_eq!(scan["indexed"], 1);

    let list = core
        .dispatch("asset.list", json!({"library_id": lib.id}))
        .unwrap();
    let asset = &list["items"][0];
    let id = asset["id"].as_str().unwrap();
    assert_eq!(asset["availability"], "available");
    // 600x400 Track 1 JPEG rotated 90 CW via CMT1 Orientation=6 -> 400x600!
    assert_eq!(asset["width"], 400);
    assert_eq!(asset["height"], 600);
    assert_eq!(asset["captured_at"], "2026-11-12T09:15:30.450000000");
    assert_eq!(asset["metadata"]["Camera"], "Canon EOS R5");
    assert_eq!(asset["metadata"]["Lens"], "RF24-70mm F2.8 L IS USM");
    assert_eq!(asset["metadata"]["ISO"], "400");
    assert_eq!(asset["metadata"]["Color Profile"], "Adobe RGB (1998)");

    // Generated EXIF filter columns work on CR3 too!
    let filtered = core
        .dispatch(
            "asset.list",
            json!({"library_id": lib.id, "camera": "Canon EOS R5", "iso_min": 300, "iso_max": 500}),
        )
        .unwrap();
    assert_eq!(filtered["total"], 1);

    // Full tier selects the largest Track 1 JPEG (400x600) and embeds Adobe RGB (1998) ICC!
    let full = core.preview_image(id, PreviewTier::Full, false).unwrap();
    assert_eq!(full.source, "embedded_jpeg");
    assert_eq!((full.width, full.height), (400, 600));
    let icc = decoded_icc(&full.jpeg).expect("Adobe RGB ICC profile must be synthesized");
    assert!(icc.windows(16).any(|w| w == b"Adobe RGB (1998)"));

    // Remote range preview also works on CR3!
    let mut cursor = Cursor::new(cr3_bytes);
    let len = cursor.get_ref().len() as u64;
    let remote = remote_preview(&mut cursor, len, None, PreviewTier::T256).unwrap();
    assert_eq!(remote.source, "remote_embedded_jpeg");
    assert!(decoded_icc(&remote.jpeg).is_some());
    assert_eq!(
        remote.meta()["inspection"]["metadata"]["Camera"],
        "Canon EOS R5"
    );

    // Explicit sensor mode & full RAW export remain honest about CR3 sensor decoding.
    assert!(core
        .preview_image_with_mode(id, PreviewTier::P2560, false, true)
        .is_err());
    let export_out = temp.path().join("out.jpg");
    assert!(core
        .dispatch("asset.export", json!({"id": id, "destination": export_out}))
        .is_err());
}

#[test]
fn adobe_rgb_exif_jpeg_synthesizes_icc_profile_in_preview_and_export() {
    let temp = tempfile::tempdir().unwrap();
    let raw_jpeg = encode_jpeg(320, 240, [200, 60, 50]);
    let exif_tiff = single_ifd_tiff(&[]);
    // Build a JPEG with APP1 Exif setting InteroperabilityIndex = R03 / ColorSpace = 2.
    let primary_with_exif = {
        // IFD0 pointing to ExifIFD with ColorSpace = 2
        let mut tiff = vec![0_u8; 8 + 2 + 12 + 4 + 2 + 12 + 4];
        tiff[0..4].copy_from_slice(b"II\x2a\x00");
        tiff[4..8].copy_from_slice(&8_u32.to_le_bytes());
        tiff[8..10].copy_from_slice(&1_u16.to_le_bytes());
        let exif_ifd_off = 26_u32;
        tiff[10..12].copy_from_slice(&0x8769_u16.to_le_bytes());
        tiff[12..14].copy_from_slice(&4_u16.to_le_bytes());
        tiff[14..18].copy_from_slice(&1_u32.to_le_bytes());
        tiff[18..22].copy_from_slice(&exif_ifd_off.to_le_bytes());
        tiff[26..28].copy_from_slice(&1_u16.to_le_bytes());
        tiff[28..30].copy_from_slice(&0xa001_u16.to_le_bytes()); // ColorSpace
        tiff[30..32].copy_from_slice(&3_u16.to_le_bytes()); // SHORT
        tiff[32..36].copy_from_slice(&1_u32.to_le_bytes());
        tiff[36..38].copy_from_slice(&2_u16.to_le_bytes()); // 2 = Adobe RGB
        let _ = exif_tiff;
        tiff
    };
    let mut app1 = Vec::new();
    app1.extend_from_slice(&[0xff, 0xe1]);
    let seg_len = (2 + 6 + primary_with_exif.len()) as u16;
    app1.extend_from_slice(&seg_len.to_be_bytes());
    app1.extend_from_slice(b"Exif\0\0");
    app1.extend_from_slice(&primary_with_exif);

    let mut tagged_jpeg = Vec::new();
    tagged_jpeg.extend_from_slice(&raw_jpeg[..2]);
    tagged_jpeg.extend_from_slice(&app1);
    tagged_jpeg.extend_from_slice(&raw_jpeg[2..]);

    let photos = temp.path().join("photos");
    fs::create_dir_all(&photos).unwrap();
    let jpg_path = photos.join("_MG_2002.JPG");
    fs::write(&jpg_path, tagged_jpeg).unwrap();

    let core = Core::open(temp.path().join("catalog.sqlite")).unwrap();
    let opened = core.dispatch("file.open", json!({"path": jpg_path})).unwrap();
    let id = opened["id"].as_str().unwrap();
    assert_eq!(opened["metadata"]["Color Profile"], "Adobe RGB (1998)");

    let preview = core.preview_image(id, PreviewTier::P2560, false).unwrap();
    let icc = decoded_icc(&preview.jpeg).expect("Preview must embed synthesized Adobe RGB ICC");
    assert!(icc.windows(16).any(|w| w == b"Adobe RGB (1998)"));

    let exported = temp.path().join("exported.jpg");
    core.dispatch("asset.export", json!({"id": id, "destination": &exported}))
        .unwrap();
    let exp_bytes = fs::read(&exported).unwrap();
    assert!(decoded_icc(&exp_bytes).is_some());
}

#[cfg(target_os = "macos")]
fn write_display_p3_heic(path: & std::path::Path, width: usize, height: usize, rgba_pixel: [u8; 4]) {
    use std::{ffi::c_void, os::unix::ffi::OsStrExt, ptr};

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
        fn CFURLCreateFromFileSystemRepresentation(
            allocator: *const c_void,
            buffer: *const u8,
            buf_len: isize,
            is_directory: u8,
        ) -> *const c_void;
        fn CFStringCreateWithBytes(
            alloc: *const c_void,
            bytes: *const u8,
            num_bytes: isize,
            encoding: u32,
            is_external_representation: u8,
        ) -> *const c_void;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        static kCGColorSpaceDisplayP3: *const c_void;
        fn CGColorSpaceCreateWithName(name: *const c_void) -> *const c_void;
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: *const c_void,
            bitmap_info: u32,
        ) -> *mut c_void;
        fn CGBitmapContextCreateImage(context: *mut c_void) -> *const c_void;
    }

    #[link(name = "ImageIO", kind = "framework")]
    extern "C" {
        fn CGImageDestinationCreateWithURL(
            url: *const c_void,
            r#type: *const c_void,
            count: usize,
            options: *const c_void,
        ) -> *mut c_void;
        fn CGImageDestinationAddImage(
            idst: *mut c_void,
            image: *const c_void,
            properties: *const c_void,
        );
        fn CGImageDestinationFinalize(idst: *mut c_void) -> bool;
    }

    let mut rgba = vec![0_u8; width * height * 4];
    for px in rgba.chunks_exact_mut(4) {
        px.copy_from_slice(&rgba_pixel);
    }
    unsafe {
        let space = CGColorSpaceCreateWithName(kCGColorSpaceDisplayP3);
        assert!(!space.is_null());
        let ctx = CGBitmapContextCreate(
            rgba.as_mut_ptr().cast::<c_void>(),
            width,
            height,
            8,
            width * 4,
            space,
            1 | (2 << 12),
        );
        assert!(!ctx.is_null());
        let cg_img = CGBitmapContextCreateImage(ctx);
        assert!(!cg_img.is_null());
        let raw_path = path.as_os_str().as_bytes();
        let url = CFURLCreateFromFileSystemRepresentation(
            ptr::null(),
            raw_path.as_ptr(),
            raw_path.len() as isize,
            0,
        );
        let uti = CFStringCreateWithBytes(
            ptr::null(),
            b"public.heic".as_ptr(),
            11,
            0x0800_0100,
            0,
        );
        let dest = CGImageDestinationCreateWithURL(url, uti, 1, ptr::null());
        assert!(!dest.is_null());
        CGImageDestinationAddImage(dest, cg_img, ptr::null());
        assert!(CGImageDestinationFinalize(dest), "HEIC finalize failed");
        CFRelease(dest.cast_const());
        CFRelease(uti);
        CFRelease(url);
        CFRelease(cg_img);
        CFRelease(ctx.cast_const());
        CFRelease(space);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn macos_imageio_decodes_heic_for_indexing_previews_and_export() {
    let temp = tempfile::tempdir().unwrap();
    let photos = temp.path().join("photos");
    fs::create_dir_all(&photos).unwrap();
    let heic_path = photos.join("IMG_0001.HEIC");
    write_display_p3_heic(&heic_path, 320, 200, [40, 170, 95, 255]);

    let core = Core::open(temp.path().join("catalog.sqlite")).unwrap();
    let lib = core.add_library("iPhone HEIC", &photos).unwrap();
    let scan = core
        .dispatch("library.scan", json!({"library_id": lib.id}))
        .unwrap();
    assert_eq!(scan["indexed"], 1);
    let list = core
        .dispatch("asset.list", json!({"library_id": lib.id}))
        .unwrap();
    let asset = &list["items"][0];
    let id = asset["id"].as_str().unwrap();
    assert_eq!(asset["availability"], "available");
    assert_eq!(asset["width"], 320);
    assert_eq!(asset["height"], 200);
    assert_eq!(asset["metadata"]["Decoder"], "macOS ImageIO");

    let thumb = core.preview_image(id, PreviewTier::T256, false).unwrap();
    assert_eq!((thumb.width, thumb.height), (256, 160));
    assert!(decoded_icc(&thumb.jpeg).is_some(), "Display P3 ICC preserved on HEIC thumbnail");

    let full = core.preview_image(id, PreviewTier::Full, false).unwrap();
    assert_eq!((full.width, full.height), (320, 200));
    assert!(decoded_icc(&full.jpeg).is_some(), "Display P3 ICC preserved on HEIC full preview");

    let export_jpg = temp.path().join("heic-export.jpg");
    core.dispatch("asset.export", json!({"id": id, "destination": &export_jpg}))
        .unwrap();
    let exp_bytes = fs::read(&export_jpg).unwrap();
    assert!(decoded_icc(&exp_bytes).is_some(), "Display P3 ICC preserved on HEIC export");
    let decoded = image::open(&export_jpg).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (320, 200));
}
