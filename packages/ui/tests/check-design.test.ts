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
