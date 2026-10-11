// Bundles the in-browser subtitle renderer (JASSUB / libass) for the player. The browser cannot resolve bare
// package imports, so its code is bundled once into public/vendor/jassub/. The wasm binaries and the default font
// stay in node_modules/jassub/dist and are served from /vendor/jassub-dist/.
//   npm run build:vendor
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'node_modules', 'jassub', 'dist');
const common = { bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none', logLevel: 'info' };
await build({ ...common, entryPoints: [path.join(dist, 'jassub.js')], outfile: path.join(root, 'public', 'vendor', 'jassub', 'jassub.js') });
await build({ ...common, entryPoints: [path.join(dist, 'worker', 'worker.js')], outfile: path.join(root, 'public', 'vendor', 'jassub', 'worker.js') });
