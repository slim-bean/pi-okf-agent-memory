import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Use an explicit test runtime, a local peer install, or the user's global pi.
const require = createRequire(import.meta.url);
let piDir = process.env.PI_TEST_PACKAGE_DIR;
if (!piDir) {
  try { piDir = dirname(dirname(require.resolve('@earendil-works/pi-coding-agent'))); }
  catch { piDir = join(execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent'); }
}
export const piPackageDir = piDir;
const piRequire = createRequire(join(piDir, 'package.json'));
const { createJiti } = await import(pathToFileURL(piRequire.resolve('jiti')).href);
export const jiti = createJiti(import.meta.url, {
  alias: {
    '@earendil-works/pi-coding-agent': join(piDir, 'dist/index.js'),
    typebox: piRequire.resolve('typebox'),
  },
});
