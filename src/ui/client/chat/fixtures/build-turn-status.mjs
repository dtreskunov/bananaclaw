import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['fixtures/turn-status.tsx'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  loader: { '.ttf': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  entryNames: 'turn-status-fixture-[hash]',
  outdir: 'dist',
  metafile: true,
  logLevel: 'info',
});
const entry = Object.entries(result.metafile.outputs).find(
  ([path, output]) => path.endsWith('.js') && output.entryPoint === 'fixtures/turn-status.tsx',
);
if (!entry?.[1].cssBundle) throw new Error('Fixture JavaScript or CSS bundle is missing');
const script = basename(entry[0]);
const stylesheet = basename(entry[1].cssBundle);
const template = await readFile(join(root, 'fixtures/turn-status.html'), 'utf8');
const html = template.replace('./turn-status-fixture.js', `./${script}`).replace('./turn-status-fixture.css', `./${stylesheet}`);
const hash = createHash('sha256').update(html).digest('hex').slice(0, 12);
const name = `turn-status-fixture-${hash}.html`;
await writeFile(join(root, 'dist', name), html);
console.log(`Fixture: /ui/chat/dist/${name}`);
