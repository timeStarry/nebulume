// Design-rule check for CSS outside the design system.
// Colours, shadows, weights, pixel font sizes, gradients and blur belong in src/ui/ and tokens.css.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = [
  ['hex-color', /#[0-9a-f]{3,8}\b/i],
  ['shadow', /box-shadow\s*:\s*(?!none\b)(?!inset\b)(?![^;]*\binset\b)[^;]*/i],
  ['font-weight', /font-weight\s*:\s*(?!400\b|500\b|inherit\b|var\()[^;]+/i],
  ['font-size-px', /font-size\s*:\s*\d+(\.\d+)?px/i],
  ['gradient', /(linear|radial|conic)-gradient\s*\(/i],
  ['blur', /\bblur\s*\(/i],
  ['rgb-color', /\b(rgb|rgba|hsl|hsla)\s*\(/i],
];

const exempt = (path) => {
  const normal = path.split(sep).join('/');
  return /(^|\/)src\/ui\//.test(normal) || /(^|\/)src\/tokens\.css$/.test(normal);
};

/** Returns one finding per rule per line. Comments are stripped first, keeping line numbers. */
export function checkCss(path, text) {
  if (exempt(path)) return [];
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const findings = [];
  stripped.split('\n').forEach((line, index) => {
    for (const [rule, pattern] of RULES) {
      const match = line.match(pattern);
      if (match) findings.push({ line: index + 1, rule, snippet: match[0].trim() });
    }
  });
  return findings;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.css')) out.push(full);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const allow = new Set(
    JSON.parse(readFileSync(new URL('./design-allowlist.json', import.meta.url), 'utf8')),
  );
  let failed = 0;
  for (const file of walk(join(root, 'src'))) {
    const path = relative(root, file).split(sep).join('/');
    if (allow.has(path)) continue;
    for (const finding of checkCss(path, readFileSync(file, 'utf8'))) {
      failed++;
      console.error(`${path}:${finding.line}  ${finding.rule}  ${finding.snippet}`);
    }
  }
  if (failed) {
    console.error(
      `\ndesign check: ${failed} finding(s). Use tokens from src/tokens.css or a src/ui component.`,
    );
    process.exit(1);
  }
  console.log(`design check: clean (${allow.size} legacy file(s) still allowlisted)`);
}
