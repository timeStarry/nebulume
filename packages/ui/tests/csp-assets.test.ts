import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const tauriConfPath = join(uiRoot, '../../crates/neb-app/tauri.conf.json');

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (/\.(ts|tsx|css|html)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('desktop CSP and Vite asset bundling parity', () => {
  it('disables Vite data-URI asset inlining whenever Tauri img-src omits data:', () => {
    const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8')) as {
      app?: { security?: { csp?: string } };
    };
    const csp = tauriConf.app?.security?.csp ?? '';
    const imgSrc = csp
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('img-src '));
    expect(imgSrc).toBeDefined();

    if (!imgSrc!.split(/\s+/).includes('data:')) {
      expect(viteConfig.build?.assetsInlineLimit).toBe(0);
    }
  });

  it('never embeds literal data:image URLs in UI source or stylesheets', () => {
    const files = [...walkFiles(join(uiRoot, 'src')), join(uiRoot, 'index.html')];
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (/data:image\//i.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
