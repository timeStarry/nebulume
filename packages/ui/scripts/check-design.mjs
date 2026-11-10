// Design-rule check for CSS outside the design system.
// Colours, shadows, weights, pixel font sizes, gradients and blur belong in src/ui/ and tokens.css.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAMED_COLORS =
  /^(white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink|brown|navy|teal|aqua|lime|maroon|olive|fuchsia)$/i;

/** Splits a comma-separated value at top level (not inside parentheses). */
function layers(value) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The rules a single declaration breaks. Values are judged; selectors never are. */
function judge(property, value) {
  const found = [];
  const prop = property.toLowerCase();
  const v = value.trim();
  if (/#[0-9a-f]{3,8}\b/i.test(v)) found.push('hex-color');
  if (/\b(rgb|rgba|hsl|hsla|color-mix)\s*\(/i.test(v)) found.push('rgb-color');
  if (/^(color|background|background-color|border(-[a-z]+)?-color|border|outline|outline-color|fill|stroke|text-decoration-color)$/.test(prop))
    for (const word of v.split(/[\s,]+/)) if (NAMED_COLORS.test(word)) {
      found.push('named-color');
      break;
    }
  if (prop === 'box-shadow' && !/^none$/i.test(v)) {
    // Only rings drawn inside the box are allowed; any outer layer is a shadow.
    if (layers(v).some((layer) => !/\binset\b/i.test(layer))) found.push('shadow');
  }
  if (prop === 'text-shadow' && !/^none$/i.test(v)) found.push('shadow');
  if (/\bdrop-shadow\s*\(/i.test(v)) found.push('shadow');
  const weight = prop === 'font-weight' ? v : prop === 'font' ? (v.match(/^(?:italic\s+|normal\s+)?(\d{3}|bold|bolder|lighter)\b/i)?.[1] ?? '') : '';
  if (weight && !/^(400|500|normal|inherit|initial|unset)$/i.test(weight) && !/^var\(/.test(weight))
    found.push('font-weight');
  const size = prop === 'font-size' ? v : prop === 'font' ? v : '';
  if (size && /(^|\s|\/)\d+(\.\d+)?px\b/.test(prop === 'font' ? v.replace(/\/\s*[\d.]+(px)?/, '') : v))
    found.push('font-size-px');
  if (/(linear|radial|conic)-gradient\s*\(/i.test(v)) found.push('gradient');
  if (/\bblur\s*\(/i.test(v)) found.push('blur');
  return found;
}

const exempt = (path) => {
  const normal = path.split(sep).join('/');
  return /(^|\/)src\/ui\//.test(normal) || /(^|\/)src\/tokens\.css$/.test(normal);
};

/**
 * Returns the broken rules for each declaration, with its line. Comments are stripped first
 * (keeping line numbers). A box-shadow used as a mask is allowed on the line after a
 * `/* design: mask *\/` comment.
 */
export function checkCss(path, text) {
  if (exempt(path)) return [];
  const masked = new Set();
  text.split('\n').forEach((line, index) => {
    if (/\/\*\s*design:\s*mask\s*\*\//.test(line)) masked.add(index + 2);
  });
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const findings = [];
  const declaration = /([a-z-]+)\s*:\s*([^;{}]+)/gi;
  // Declarations live inside braces; strip selectors by only scanning brace bodies.
  let depth = 0;
  let line = 1;
  let body = '';
  let bodyStart = 1;
  const flush = () => {
    let offset = 0;
    const lines = body.split('\n');
    lines.forEach((text, index) => {
      for (const match of text.matchAll(declaration)) {
        const at = bodyStart + index;
        for (const rule of judge(match[1], match[2])) {
          if (rule === 'shadow' && masked.has(at)) continue;
          findings.push({ line: at, rule, snippet: `${match[1]}: ${match[2].trim()}` });
        }
      }
      offset += text.length + 1;
    });
    body = '';
  };
  for (const char of stripped) {
    if (char === '{') {
      depth++;
      body = '';
      bodyStart = line;
    } else if (char === '}') {
      flush();
      depth = Math.max(0, depth - 1);
    } else if (depth > 0) body += char;
    if (char === '\n') line++;
  }
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
