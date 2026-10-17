"""Validate the committed application icons without regenerating or modifying them.

This compatibility entry point checks the runtime SVG, PNG, ICO, and ICNS files
used by the web frontend and desktop bundle. It needs only Python's standard
library; application builds do not require separate design source files.
"""
from pathlib import Path
import hashlib
import json
import struct
import xml.etree.ElementTree as ET
import zlib

ROOT = Path(__file__).resolve().parents[1]
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def png_dimensions(data):
    require(data.startswith(PNG_SIGNATURE), 'Invalid PNG signature')
    offset = len(PNG_SIGNATURE)
    dimensions = None
    has_pixels = False
    while offset < len(data):
        require(offset + 12 <= len(data), 'Truncated PNG chunk')
        size, kind = struct.unpack_from('>I4s', data, offset)
        end = offset + 12 + size
        require(end <= len(data), 'PNG chunk exceeds file bounds')
        payload = data[offset + 8:end - 4]
        expected_crc = struct.unpack_from('>I', data, end - 4)[0]
        require(zlib.crc32(kind + payload) == expected_crc, 'Invalid PNG chunk checksum')
        if kind == b'IHDR':
            require(dimensions is None and offset == 8 and size == 13, 'Invalid PNG header')
            width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', payload)
            require(width > 0 and height > 0, 'Empty PNG dimensions')
            require((depth, color, compression, filtering, interlace) == (8, 6, 0, 0, 0), 'Expected an 8-bit RGBA PNG')
            dimensions = (width, height)
        elif kind == b'IDAT':
            has_pixels = True
        elif kind == b'IEND':
            require(size == 0 and end == len(data), 'Invalid PNG end chunk')
            require(dimensions is not None and has_pixels, 'Incomplete PNG')
            return dimensions
        offset = end
    raise ValueError('Missing PNG end chunk')


def ico_sizes(data):
    require(len(data) >= 6, 'Truncated ICO header')
    reserved, kind, count = struct.unpack_from('<HHH', data)
    require((reserved, kind) == (0, 1) and count > 0, 'Invalid ICO header')
    table_end = 6 + 16 * count
    require(table_end <= len(data), 'Truncated ICO directory')
    sizes = set()
    for index in range(count):
        width, height, _, _, _, _, size, offset = struct.unpack_from('<BBBBHHII', data, 6 + 16 * index)
        expected = (width or 256, height or 256)
        require(offset >= table_end and offset + size <= len(data), 'ICO image exceeds file bounds')
        require(png_dimensions(data[offset:offset + size]) == expected, 'ICO image dimensions do not match its directory')
        require(expected not in sizes, 'Duplicate ICO image dimensions')
        sizes.add(expected)
    return sizes


def icns_sizes(data):
    require(len(data) >= 8 and data[:4] == b'icns', 'Invalid ICNS header')
    require(struct.unpack_from('>I', data, 4)[0] == len(data), 'Invalid ICNS file length')
    expected_sizes = {
        b'icp4': 16, b'ic11': 32, b'icp5': 32, b'ic12': 64,
        b'ic07': 128, b'ic13': 256, b'ic08': 256,
        b'ic14': 512, b'ic09': 512, b'ic10': 1024,
    }
    offset = 8
    sizes = set()
    kinds = set()
    while offset < len(data):
        require(offset + 8 <= len(data), 'Truncated ICNS image header')
        kind, size = struct.unpack_from('>4sI', data, offset)
        require(size >= 8 and offset + size <= len(data), 'ICNS image exceeds file bounds')
        require(kind in expected_sizes and kind not in kinds, 'Unexpected or duplicate ICNS image type')
        pixels = expected_sizes[kind]
        require(png_dimensions(data[offset + 8:offset + size]) == (pixels, pixels), 'ICNS image dimensions do not match its type')
        kinds.add(kind)
        sizes.add((pixels, pixels))
        offset += size
    return sizes


def validate_svg(data):
    svg = ET.fromstring(data)
    require(svg.tag == '{http://www.w3.org/2000/svg}svg', 'Invalid SVG root')
    require(svg.get('viewBox') == '0 0 256 256', 'Unexpected SVG view box')
    require(any(node.tag == '{http://www.w3.org/2000/svg}path' for node in svg.iter()), 'SVG contains no paths')


def main():
    validated = []
    pngs = {
        'crates/neb-app/icons/32x32.png': 32,
        'crates/neb-app/icons/128x128.png': 128,
        'crates/neb-app/icons/128x128@2x.png': 256,
        'crates/neb-app/icons/icon.png': 512,
        'packages/ui/public/apple-touch-icon.png': 180,
    }
    expected = {
        **{path: {(size, size)} for path, size in pngs.items()},
        'crates/neb-app/icons/icon.ico': {(size, size) for size in (16, 20, 24, 32, 40, 48, 64, 128, 256)},
        'packages/ui/public/favicon.ico': {(size, size) for size in (16, 24, 32, 48)},
        'crates/neb-app/icons/icon.icns': {(size, size) for size in (16, 32, 64, 128, 256, 512, 1024)},
        'packages/ui/src/assets/brand-mark.svg': None,
        'packages/ui/src/assets/brand-mark-ink.svg': None,
        'packages/ui/public/favicon.svg': None,
    }
    for relative, dimensions in expected.items():
        path = ROOT / relative
        data = path.read_bytes()
        if path.suffix == '.svg':
            validate_svg(data)
        else:
            readers = {'.png': lambda content: {png_dimensions(content)}, '.ico': ico_sizes, '.icns': icns_sizes}
            require(readers[path.suffix](data) == dimensions, f'Unexpected icon sizes: {relative}')
        validated.append({'path': relative, 'sha256': hashlib.sha256(data).hexdigest()})
    configuration = ROOT / 'crates/neb-app/tauri.conf.json'
    for icon in json.loads(configuration.read_text(encoding='utf-8'))['bundle']['icon']:
        require((configuration.parent / icon).is_file(), f'Missing desktop bundle icon: {icon}')
    print(json.dumps({'validated_assets': validated}, ensure_ascii=False))


if __name__ == '__main__':
    main()
