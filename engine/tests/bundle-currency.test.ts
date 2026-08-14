import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Guards against a committed web/bundle.js that's drifted from web/main.ts (the demo
 *  ships a pre-built bundle — see README "Running it" — so a source change with a
 *  forgotten `npm run build-web` would otherwise ship stale JS silently). Rebuilds with
 *  the same esbuild invocation as the build-web script into a throwaway temp file and
 *  hash-compares against the committed bundle. */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ESBUILD = join(ROOT, 'node_modules', '.bin', 'esbuild');
const MAIN_TS = join(ROOT, 'web', 'main.ts');
const BUNDLE_JS = join(ROOT, 'web', 'bundle.js');

const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

test('web/bundle.js matches a fresh build of web/main.ts', () => {
  const freshPath = join(tmpdir(), `bundle-currency-${process.pid}-${Date.now()}.js`);
  try {
    execFileSync(ESBUILD, [MAIN_TS, '--bundle', '--format=iife', '--target=es2020', `--outfile=${freshPath}`]);

    const fresh = readFileSync(freshPath);
    const committed = readFileSync(BUNDLE_JS);

    assert.equal(
      sha256(fresh),
      sha256(committed),
      'web/bundle.js is stale — run: npm run build-web',
    );
  } finally {
    unlinkSync(freshPath);
  }
});
