//! Native macOS `ImageIO.framework` + `CoreGraphics.framework` bridge for modern
//! container raster codecs (`HEIC`, `HEIF`, `AVIF`) that pure-Rust `image` does
//! not decode. Preserves wide-gamut ICC profiles (e.g. Display P3 / Rec.2020 /
//! Adobe RGB) and enforces Nebulume's dimension limits before allocating pixels.

use std::{ffi::c_void, os::unix::ffi::OsStrExt, path::Path, ptr};

use anyhow::{bail, ensure, Context, Result};
use image::{metadata::Orientation, DynamicImage, RgbImage};

use crate::imaging::{MAX_FILE_BYTES, MAX_PIXELS};

type CFTypeRef = *const c_void;
type CFAllocatorRef = *const c_void;
type CFURLRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFStringRef = *const c_void;
type CFNumberRef = *const c_void;
type CFDataRef = *const c_void;
type CFBooleanRef = *const c_void;
type CGImageSourceRef = *const c_void;
type CGImageRef = *const c_void;
type CGColorSpaceRef = *const c_void;
type CGContextRef = *mut c_void;

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const K_CF_NUMBER_SINT64_TYPE: isize = 4;
const K_CG_COLOR_SPACE_MODEL_RGB: i32 = 1;
/// `kCGImageAlphaPremultipliedLast (1) | kCGBitmapByteOrder32Big (2 << 12)`:
/// guarantees `[R, G, B, A]` byte layout in memory on little- and big-endian CPUs.
const RGBA8_BITMAP_INFO: u32 = 1 | (2 << 12);

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: CFBooleanRef;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;

    fn CFRelease(cf: CFTypeRef);
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: CFAllocatorRef,
        buffer: *const u8,
        buf_len: isize,
        is_directory: u8,
    ) -> CFURLRef;
    fn CFStringCreateWithBytes(
        alloc: CFAllocatorRef,
        bytes: *const u8,
        num_bytes: isize,
        encoding: u32,
        is_external_representation: u8,
    ) -> CFStringRef;
    fn CFStringGetLength(the_string: CFStringRef) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetCString(
        the_string: CFStringRef,
        buffer: *mut u8,
        buffer_size: isize,
        encoding: u32,
    ) -> u8;
    fn CFDictionaryGetValue(the_dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
    fn CFDictionaryCreate(
        allocator: CFAllocatorRef,
        keys: *const *const c_void,
        values: *const *const c_void,
        num_values: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFDictionaryRef;
    fn CFNumberCreate(
        allocator: CFAllocatorRef,
        the_type: isize,
        value_ptr: *const c_void,
    ) -> CFNumberRef;
    fn CFNumberGetValue(number: CFNumberRef, the_type: isize, value_ptr: *mut c_void) -> u8;
    fn CFDataGetLength(the_data: CFDataRef) -> isize;
    fn CFDataGetBytePtr(the_data: CFDataRef) -> *const u8;
    #[cfg(test)]
    fn CFDataCreate(allocator: CFAllocatorRef, bytes: *const u8, length: isize) -> CFDataRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGImageGetWidth(image: CGImageRef) -> usize;
    fn CGImageGetHeight(image: CGImageRef) -> usize;
    fn CGImageGetColorSpace(image: CGImageRef) -> CGColorSpaceRef;
    fn CGColorSpaceGetModel(space: CGColorSpaceRef) -> i32;
    fn CGColorSpaceCopyICCData(space: CGColorSpaceRef) -> CFDataRef;
    fn CGColorSpaceCreateDeviceRGB() -> CGColorSpaceRef;
    #[cfg(test)]
    fn CGColorSpaceCreateWithICCData(data: CFTypeRef) -> CGColorSpaceRef;
    fn CGBitmapContextCreate(
        data: *mut c_void,
        width: usize,
        height: usize,
        bits_per_component: usize,
        bytes_per_row: usize,
        space: CGColorSpaceRef,
        bitmap_info: u32,
    ) -> CGContextRef;
    fn CGContextDrawImage(c: CGContextRef, rect: CGRect, image: CGImageRef);
}

#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    static kCGImageSourceCreateThumbnailFromImageAlways: CFStringRef;
    static kCGImageSourceCreateThumbnailWithTransform: CFStringRef;
    static kCGImageSourceShouldCacheImmediately: CFStringRef;
    static kCGImageSourceThumbnailMaxPixelSize: CFStringRef;

    fn CGImageSourceCreateWithURL(url: CFURLRef, options: CFDictionaryRef) -> CGImageSourceRef;
    fn CGImageSourceGetCount(isrc: CGImageSourceRef) -> usize;
    fn CGImageSourceCopyPropertiesAtIndex(
        isrc: CGImageSourceRef,
        index: usize,
        options: CFDictionaryRef,
    ) -> CFDictionaryRef;
    fn CGImageSourceCreateImageAtIndex(
        isrc: CGImageSourceRef,
        index: usize,
        options: CFDictionaryRef,
    ) -> CGImageRef;
    fn CGImageSourceCreateThumbnailAtIndex(
        isrc: CGImageSourceRef,
        index: usize,
        options: CFDictionaryRef,
    ) -> CGImageRef;
}

struct CfGuard(CFTypeRef);

impl CfGuard {
    fn new(ptr: CFTypeRef) -> Option<Self> {
        (!ptr.is_null()).then_some(Self(ptr))
    }

    fn as_ptr(&self) -> CFTypeRef {
        self.0
    }
}

impl Drop for CfGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: `CfGuard` only wraps non-null CoreFoundation / CoreGraphics
            // objects created via Create/Copy functions owned by this scope.
            unsafe { CFRelease(self.0) };
        }
    }
}

fn cf_string(text: &str) -> Result<CfGuard> {
    let raw = unsafe {
        CFStringCreateWithBytes(
            ptr::null(),
            text.as_ptr(),
            text.len() as isize,
            K_CF_STRING_ENCODING_UTF8,
            0,
        )
    };
    CfGuard::new(raw).context("E_OPERATION: Failed to allocate CFString")
}

fn dict_i64(dict: CFDictionaryRef, key: &str) -> Option<i64> {
    let key = cf_string(key).ok()?;
    let val = unsafe { CFDictionaryGetValue(dict, key.as_ptr()) };
    if val.is_null() {
        return None;
    }
    let mut out: i64 = 0;
    let ok = unsafe {
        CFNumberGetValue(
            val as CFNumberRef,
            K_CF_NUMBER_SINT64_TYPE,
            (&mut out as *mut i64).cast::<c_void>(),
        )
    };
    (ok != 0).then_some(out)
}

fn dict_string(dict: CFDictionaryRef, key: &str) -> Option<String> {
    let key = cf_string(key).ok()?;
    let val = unsafe { CFDictionaryGetValue(dict, key.as_ptr()) };
    if val.is_null() {
        return None;
    }
    let len = unsafe { CFStringGetLength(val as CFStringRef) };
    if len <= 0 || len > 512 {
        return None;
    }
    let cap = unsafe { CFStringGetMaximumSizeForEncoding(len, K_CF_STRING_ENCODING_UTF8) } + 1;
    if cap <= 1 || cap > 2048 {
        return None;
    }
    let mut buf = vec![0_u8; cap as usize];
    let ok = unsafe {
        CFStringGetCString(
            val as CFStringRef,
            buf.as_mut_ptr(),
            cap,
            K_CF_STRING_ENCODING_UTF8,
        )
    };
    if ok == 0 {
        return None;
    }
    let nul = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8(buf[..nul].to_vec()).ok()
}

fn open_image_source(path: &Path) -> Result<CfGuard> {
    let info = path
        .metadata()
        .with_context(|| format!("E_OFFLINE: Cannot read {}", path.display()))?;
    ensure!(info.is_file(), "E_INVALID: Image is not a regular file");
    ensure!(
        info.len() <= MAX_FILE_BYTES,
        "E_LIMIT: Image exceeds the 512 MiB decode limit"
    );
    let raw_path = path.as_os_str().as_bytes();
    let url = CfGuard::new(unsafe {
        CFURLCreateFromFileSystemRepresentation(
            ptr::null(),
            raw_path.as_ptr(),
            raw_path.len() as isize,
            0,
        )
    })
    .context("E_INVALID: Invalid filesystem path for ImageIO")?;
    let source = CfGuard::new(unsafe { CGImageSourceCreateWithURL(url.as_ptr(), ptr::null()) })
        .context("E_UNSUPPORTED_CODEC: ImageIO could not open container")?;
    let count = unsafe { CGImageSourceGetCount(source.as_ptr()) };
    ensure!(
        count >= 1,
        "E_UNSUPPORTED_CODEC: Image container has no decodable primary image"
    );
    Ok(source)
}

fn inspect_source(source: &CfGuard) -> Result<(u32, u32, u8, Option<String>)> {
    let props = CfGuard::new(unsafe {
        CGImageSourceCopyPropertiesAtIndex(source.as_ptr(), 0, ptr::null())
    })
    .context("E_UNSUPPORTED_CODEC: ImageIO metadata properties unavailable")?;
    let width = dict_i64(props.as_ptr(), "PixelWidth")
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0)
        .context("E_UNSUPPORTED_CODEC: Missing valid PixelWidth")?;
    let height = dict_i64(props.as_ptr(), "PixelHeight")
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0)
        .context("E_UNSUPPORTED_CODEC: Missing valid PixelHeight")?;
    ensure!(
        u64::from(width) * u64::from(height) <= MAX_PIXELS,
        "E_LIMIT: Image dimensions exceed the 120 megapixel decode limit"
    );
    let orientation = dict_i64(props.as_ptr(), "Orientation")
        .and_then(|v| u8::try_from(v).ok())
        .filter(|v| (1..=8).contains(v))
        .unwrap_or(1);
    let profile = dict_string(props.as_ptr(), "ProfileName");
    Ok((width, height, orientation, profile))
}

/// Inspects raw un-rotated dimensions, EXIF orientation (1..=8), and optional color
/// profile name via macOS `ImageIO` without decoding pixel planes.
pub(crate) fn inspect(path: &Path) -> Result<(u32, u32, u8, Option<String>)> {
    let source = open_image_source(path)?;
    inspect_source(&source)
}

/// Decodes a modern container image (`HEIC`, `HEIF`, `AVIF`) into an oriented
/// `DynamicImage` and returns `(image, exif_orientation, icc_profile)`.
pub(crate) fn decode(
    path: &Path,
    max_side: Option<u32>,
) -> Result<(DynamicImage, u8, Option<Vec<u8>>)> {
    let source = open_image_source(path)?;
    let (raw_w, raw_h, orientation, _) = inspect_source(&source)?;
    let long_side = raw_w.max(raw_h);

    let (cg_image, already_oriented) =
        match max_side.filter(|limit| *limit > 0 && *limit < long_side) {
            Some(limit) => {
                let max_num_val = i64::from(limit);
                let max_num = CfGuard::new(unsafe {
                    CFNumberCreate(
                        ptr::null(),
                        K_CF_NUMBER_SINT64_TYPE,
                        (&max_num_val as *const i64).cast::<c_void>(),
                    )
                })
                .context("E_OPERATION: Failed to allocate CFNumber")?;
                let keys: [*const c_void; 4] = unsafe {
                    [
                        kCGImageSourceCreateThumbnailFromImageAlways,
                        kCGImageSourceCreateThumbnailWithTransform,
                        kCGImageSourceShouldCacheImmediately,
                        kCGImageSourceThumbnailMaxPixelSize,
                    ]
                };
                let values: [*const c_void; 4] = unsafe {
                    [
                        kCFBooleanTrue,
                        kCFBooleanTrue,
                        kCFBooleanTrue,
                        max_num.as_ptr(),
                    ]
                };
                let opts = CfGuard::new(unsafe {
                    CFDictionaryCreate(
                        ptr::null(),
                        keys.as_ptr(),
                        values.as_ptr(),
                        4,
                        &kCFTypeDictionaryKeyCallBacks,
                        &kCFTypeDictionaryValueCallBacks,
                    )
                })
                .context("E_OPERATION: Failed to allocate thumbnail options")?;
                let thumb = CfGuard::new(unsafe {
                    CGImageSourceCreateThumbnailAtIndex(source.as_ptr(), 0, opts.as_ptr())
                })
                .context("E_UNSUPPORTED_CODEC: ImageIO could not decode image thumbnail")?;
                (thumb, true)
            }
            None => {
                let full = CfGuard::new(unsafe {
                    CGImageSourceCreateImageAtIndex(source.as_ptr(), 0, ptr::null())
                })
                .context("E_UNSUPPORTED_CODEC: ImageIO could not decode image")?;
                (full, false)
            }
        };

    let width = unsafe { CGImageGetWidth(cg_image.as_ptr()) };
    let height = unsafe { CGImageGetHeight(cg_image.as_ptr()) };
    if width == 0 || height == 0 || (width as u64) * (height as u64) > MAX_PIXELS {
        bail!("E_LIMIT: Decoded image dimensions are invalid or exceed 120 MP");
    }

    let img_space = unsafe { CGImageGetColorSpace(cg_image.as_ptr()) };
    let is_rgb = !img_space.is_null()
        && unsafe { CGColorSpaceGetModel(img_space) } == K_CG_COLOR_SPACE_MODEL_RGB;
    let fallback_space = if is_rgb {
        None
    } else {
        Some(
            CfGuard::new(unsafe { CGColorSpaceCreateDeviceRGB() })
                .context("E_OPERATION: Failed to create RGB color space")?,
        )
    };
    let target_space = fallback_space.as_ref().map_or(img_space, CfGuard::as_ptr);

    let icc = if is_rgb {
        CfGuard::new(unsafe { CGColorSpaceCopyICCData(img_space) }).and_then(|data| {
            let len = unsafe { CFDataGetLength(data.as_ptr()) };
            let ptr = unsafe { CFDataGetBytePtr(data.as_ptr()) };
            if len > 0 && len <= 4 * 1024 * 1024 && !ptr.is_null() {
                Some(unsafe { std::slice::from_raw_parts(ptr, len as usize) }.to_vec())
            } else {
                None
            }
        })
    } else {
        None
    };

    let stride = width
        .checked_mul(4)
        .context("E_LIMIT: Row stride overflow")?;
    let total_bytes = stride
        .checked_mul(height)
        .context("E_LIMIT: Pixel buffer overflow")?;
    let mut rgba = vec![0_u8; total_bytes];
    let ctx = CfGuard::new(
        unsafe {
            CGBitmapContextCreate(
                rgba.as_mut_ptr().cast::<c_void>(),
                width,
                height,
                8,
                stride,
                target_space,
                RGBA8_BITMAP_INFO,
            )
        }
        .cast_const(),
    )
    .context("E_DECODE: Failed to create CoreGraphics bitmap context")?;

    unsafe {
        CGContextDrawImage(
            ctx.as_ptr().cast_mut(),
            CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: CGSize {
                    width: width as f64,
                    height: height as f64,
                },
            },
            cg_image.as_ptr(),
        );
    }

    let mut rgb = Vec::with_capacity(width * height * 3);
    for px in rgba.as_chunks::<4>().0 {
        rgb.push(px[0]);
        rgb.push(px[1]);
        rgb.push(px[2]);
    }
    let rgb_img = RgbImage::from_raw(width as u32, height as u32, rgb)
        .context("E_DECODE: Invalid RGB buffer dimensions")?;
    let mut dynamic = DynamicImage::ImageRgb8(rgb_img);
    if !already_oriented {
        dynamic.apply_orientation(
            Orientation::from_exif(orientation).unwrap_or(Orientation::NoTransforms),
        );
    }
    Ok((dynamic, orientation, icc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colorsync_accepts_synthesized_adobe_rgb_1998_icc_profile() {
        let icc = crate::icc::adobe_rgb_1998_icc();
        let data =
            CfGuard::new(unsafe { CFDataCreate(ptr::null(), icc.as_ptr(), icc.len() as isize) })
                .expect("CFData");
        let space = CfGuard::new(unsafe { CGColorSpaceCreateWithICCData(data.as_ptr()) })
            .expect("ColorSync must validate synthesized Adobe RGB (1998) ICC profile");
        assert_eq!(
            unsafe { CGColorSpaceGetModel(space.as_ptr()) },
            K_CG_COLOR_SPACE_MODEL_RGB
        );
    }
}
