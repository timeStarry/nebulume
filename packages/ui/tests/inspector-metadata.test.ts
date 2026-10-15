import { describe, expect, it } from 'vitest';
import { exposureParameters, inspectorMetadataGroups } from '../src/inspector-metadata';

describe('inspector exposure summary', () => {
  it('uses actual catalog labels and preserves decoder units', () => {
    expect(exposureParameters({ Aperture: 'f/5.6', Exposure: '1/250 s', ISO: '400' })).toEqual([
      { label: '光圈', value: 'f/5.6' },
      { label: '快门', value: '1/250 s' },
      { label: 'ISO', value: '400' },
    ]);
  });

  it('accepts aliases and falls through empty common labels to recorded EXIF values', () => {
    expect(
      exposureParameters({
        Aperture: ' ',
        'EXIF FNumber': 'f/2.8',
        ExposureTime: '30 s',
        ISO: '',
        'EXIF PhotographicSensitivity': '100',
      }).map((field) => field.value),
    ).toEqual(['f/2.8', '30 s', '100']);
  });

  it('prefers the normalized catalog value and does not invent missing values from APEX data', () => {
    expect(
      exposureParameters({ Exposure: '1/125 s', ExposureTime: '1/60 s', ApertureValue: '5' }),
    ).toEqual([
      { label: '光圈', value: null },
      { label: '快门', value: '1/125 s' },
      { label: 'ISO', value: null },
    ]);
    expect(exposureParameters({}).every((field) => field.value === null)).toBe(true);
  });
});

describe('inspector metadata hierarchy', () => {
  it('groups device and capture fields while excluding repeated exposure, raw EXIF, and diagnostics', () => {
    expect(
      inspectorMetadataGroups({
        Make: 'Nikon',
        Camera: 'Z6',
        Model: 'duplicate model',
        Lens: '50 mm',
        Aperture: 'f/2',
        FNumber: 'f/2',
        Exposure: '1/60 s',
        ExposureTime: '1/60 s',
        ISO: '100',
        PhotographicSensitivity: '100',
        'EXIF ExposureTime': '1/60 s',
        'Focal Length': '50 mm',
        FocalLength: 'duplicate focal length',
        'Exposure Bias': '0 EV',
        Captured: '2026:10:15 10:00:00',
        Decoder: 'RAW',
        'Preview Source': 'raw_demosaic',
      }),
    ).toEqual([
      {
        title: '设备',
        parameters: [
          { label: '品牌', value: 'Nikon' },
          { label: '相机', value: 'Z6' },
          { label: '镜头', value: '50 mm' },
        ],
      },
      {
        title: '拍摄',
        parameters: [
          { label: '焦距', value: '50 mm' },
          { label: '曝光补偿', value: '0 EV' },
          { label: '拍摄时间', value: '2026:10:15 10:00:00' },
        ],
      },
    ]);
  });

  it('retains unknown metadata, omits empty groups, and never mutates the asset', () => {
    const metadata = Object.freeze({ Artist: 'Ada', Custom: 'recorded value', Camera: '  ' });
    expect(inspectorMetadataGroups(metadata)).toEqual([
      {
        title: '其他',
        parameters: [
          { label: '作者', value: 'Ada' },
          { label: 'Custom', value: 'recorded value' },
        ],
      },
    ]);
    expect(inspectorMetadataGroups({ Format: 'PNG', 'EXIF FNumber': 'f/8' })).toEqual([]);
  });
});
