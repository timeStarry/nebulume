import { describe, expect, test } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { checkCss } from '../scripts/check-design.mjs';

type Finding = { line: number; rule: string; snippet: string };

describe('design check', () => {
  test('flags each forbidden pattern', () => {
    const findings: Finding[] = checkCss(
      'src/x.css',
      '.a{color:#fff}\n.b{box-shadow:0 1px 2px red}\n.c{font-weight:600}\n.d{font-size:10px}\n.e{background:linear-gradient(red,blue)}\n.f{filter:blur(2px)}\n.g{color:rgb(1,2,3)}',
    );
    expect(findings.map((finding) => finding.rule)).toEqual([
      'hex-color',
      'shadow',
      'font-weight',
      'font-size-px',
      'gradient',
      'blur',
      'rgb-color',
    ]);
    expect(findings.map((finding) => finding.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  test('allows tokens, inset rings and focus outlines', () => {
    expect(
      checkCss(
        'src/x.css',
        '.a{color:var(--nl-text);box-shadow:inset 0 0 0 1px var(--nl-line);font-size:var(--nl-t-13);font-weight:500;outline:2px solid var(--nl-ring)}',
      ),
    ).toEqual([]);
  });
  test('comments are ignored', () => {
    expect(checkCss('src/x.css', '/* was #fff and 600 */\n.a{color:var(--nl-text)}')).toEqual([]);
  });
  test('ui components and tokens are exempt', () => {
    expect(checkCss('src/ui/Button.css', '.a{color:#fff}')).toEqual([]);
    expect(checkCss('src/tokens.css', '.a{color:#fff}')).toEqual([]);
  });
});

test('allowed weights pass when written on their own line', () => {
  expect(
    checkCss('src/x.css', '.a {\n  font-weight: 500;\n}\n.b {\n  font-weight: 400;\n}'),
  ).toEqual([]);
});

test('forbidden values on their own line are still caught', () => {
  const findings: Finding[] = checkCss(
    'src/x.css',
    '.a {\n  font-weight: 600;\n  font-size: 10px;\n  box-shadow: 0 1px 2px red;\n}',
  );
  expect(findings.map((finding) => finding.rule)).toEqual([
    'font-weight',
    'font-size-px',
    'shadow',
  ]);
});

test('removing a shadow is allowed', () => {
  expect(checkCss('src/x.css', '.a {\n  box-shadow: none;\n}')).toEqual([]);
});

test('a declared mask is allowed, an undeclared shadow is not', () => {
  expect(
    checkCss(
      'src/x.css',
      '.a {\n  /* design: mask */\n  box-shadow: 0 0 0 10000px var(--nl-crop-mask);\n}',
    ),
  ).toEqual([]);
  expect(
    checkCss('src/x.css', '.a {\n  box-shadow: 0 0 0 10000px var(--nl-crop-mask);\n}'),
  ).toHaveLength(1);
});

describe('design check catches what the spec forbids', () => {
  const rules = (css: string) => checkCss('src/x.css', css).map((finding: Finding) => finding.rule);
  test('an outer shadow is caught even next to an inset ring', () => {
    expect(rules('.a {\n  box-shadow: 0 4px 12px var(--x), inset 0 0 0 1px var(--y);\n}')).toEqual([
      'shadow',
    ]);
    expect(rules('.a {\n  box-shadow: inset 0 0 0 1px var(--y);\n}')).toEqual([]);
  });
  test('text shadows, drop shadows, colour mixing and named colours are caught', () => {
    expect(rules('.a {\n  text-shadow: 0 1px 2px var(--x);\n}')).toEqual(['shadow']);
    expect(rules('.a {\n  filter: drop-shadow(0 1px 2px var(--x));\n}')).toEqual(['shadow']);
    expect(rules('.a {\n  background: color-mix(in srgb, var(--x) 50%, var(--y));\n}')).toEqual([
      'rgb-color',
    ]);
    expect(rules('.a {\n  color: white;\n}')).toEqual(['named-color']);
    expect(rules('.a {\n  color: transparent;\n  border-color: currentColor;\n}')).toEqual([]);
  });
  test('the font shorthand cannot smuggle in a weight or pixel size', () => {
    expect(rules('.a {\n  font: 600 13px/1 var(--nl-font);\n}')).toEqual([
      'font-weight',
      'font-size-px',
    ]);
    expect(rules('.a {\n  font: 400 var(--nl-t-11) / 1 var(--nl-mono);\n}')).toEqual([]);
    expect(rules('.a {\n  font: inherit;\n}')).toEqual([]);
  });
  test('id selectors are not colours', () => {
    expect(rules('#add .a {\n  color: var(--nl-text);\n}')).toEqual([]);
  });
});

describe('governance rules: glass and layout motion', () => {
  const rules = (css: string) => checkCss('src/x.css', css).map((finding: Finding) => finding.rule);
  test('backdrop glass is reserved for src/ui primitives', () => {
    expect(rules('.a {\n  backdrop-filter: var(--nl-glass-blur);\n}')).toEqual(['glass']);
    expect(rules('.a {\n  backdrop-filter: none;\n}')).toEqual([]);
    expect(checkCss('src/ui/Toast.css', '.a{backdrop-filter:var(--nl-glass-blur)}')).toEqual([]);
  });
  test('transitions on layout properties are caught, transform and opacity pass', () => {
    expect(rules('.a {\n  transition: width var(--nl-d-base);\n}')).toEqual(['layout-transition']);
    expect(rules('.a {\n  transition: all 120ms;\n}')).toEqual(['layout-transition']);
    expect(rules('.a {\n  transition-property: opacity, top;\n}')).toEqual(['layout-transition']);
    expect(rules('.a {\n  transition: opacity 120ms, transform 120ms;\n}')).toEqual([]);
    expect(rules('.a {\n  transition: border-color var(--nl-d-fast) var(--nl-ease);\n}')).toEqual(
      [],
    );
  });
  test('a single bounded element may opt out explicitly', () => {
    expect(rules('.a {\n  /* design: bounded */\n  transition: width 180ms;\n}')).toEqual([]);
  });
});

describe('governance rules: spacing', () => {
  const rules = (css: string) => checkCss('src/x.css', css).map((finding: Finding) => finding.rule);
  test('raw pixel spacing is caught, tokens, hairlines and calc pass', () => {
    expect(rules('.a {\n  padding: 0 10px;\n}')).toEqual(['spacing-px']);
    expect(rules('.a {\n  gap: 6px;\n}')).toEqual(['spacing-px']);
    expect(rules('.a {\n  margin-top: -5px;\n}')).toEqual(['spacing-px']);
    expect(rules('.a {\n  padding: var(--nl-s-2) var(--nl-s-3);\n}')).toEqual([]);
    expect(rules('.a {\n  margin: -1px;\n  padding: 2px 0;\n}')).toEqual([]);
    expect(rules('.a {\n  padding-left: calc(var(--depth) * 14px);\n}')).toEqual([]);
  });
});
