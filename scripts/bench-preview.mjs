// Preview throughput benchmark through the `neb` CLI (same bytes as the `neb` protocol).
// Usage: node scripts/bench-preview.mjs --data-dir DIR --library ID [--tier t512] [--count 200]
//        [--bin target/release/neb]
// Prints one JSON line: {tier,count,cold_total_ms,warm_total_ms,cold_p50_ms,cold_p95_ms,...}.
// The cold pass is only cold if the preview cache for this tier is empty.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    library: { type: 'string' },
    tier: { type: 'string', default: 't512' },
    count: { type: 'string', default: '200' },
    bin: { type: 'string', default: 'target/release/neb' },
  },
});
if (!values['data-dir'] || !values.library) {
  console.error(
    'Usage: bench-preview.mjs --data-dir DIR --library ID [--tier t512] [--count 200] [--bin PATH]',
  );
  process.exit(2);
}
const bin = resolve(values.bin);
const dataDir = resolve(values['data-dir']);
const count = Number.parseInt(values.count, 10);
if (!Number.isInteger(count) || count < 1) {
  console.error('--count must be a positive integer');
  process.exit(2);
}

async function neb(args) {
  try {
    return await run(bin, ['--data-dir', dataDir, ...args], { maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`neb ${args[0]} failed: ${error.stderr?.trim() || error.message}`);
  }
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const round = (ms) => Math.round(ms * 10) / 10;

async function pass(ids, out) {
  const times = [];
  let bytes = 0;
  for (const id of ids) {
    const start = performance.now();
    await neb(['preview', '--id', id, '--tier', values.tier, '--out', out]);
    times.push(performance.now() - start);
    bytes += (await stat(out)).size;
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    total: round(times.reduce((sum, t) => sum + t, 0)),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    bytes,
  };
}

const listed = JSON.parse(
  (
    await neb([
      'run',
      'asset.list',
      '--json',
      JSON.stringify({ library_id: values.library, limit: count }),
    ])
  ).stdout,
);
const ids = listed.items.slice(0, count).map((asset) => asset.id);
if (ids.length === 0) {
  console.error('Library has no assets; run library.scan first');
  process.exit(1);
}
const scratch = await mkdtemp(join(tmpdir(), 'neb-bench-'));
try {
  const out = join(scratch, 'preview.jpg');
  const cold = await pass(ids, out);
  const warm = await pass(ids, out);
  console.log(
    JSON.stringify({
      tier: values.tier,
      count: ids.length,
      cold_total_ms: cold.total,
      warm_total_ms: warm.total,
      cold_p50_ms: cold.p50,
      cold_p95_ms: cold.p95,
      warm_p50_ms: warm.p50,
      warm_p95_ms: warm.p95,
      bytes: cold.bytes,
    }),
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
