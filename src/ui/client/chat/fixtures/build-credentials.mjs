// Builds the credentials settings fixture into data/dev-fixtures/credentials.
// `--serve` rebuilds on change and serves it on 127.0.0.1 (PORT, default 4175).
// `--publish` writes content-hashed files to dist/ so the running UI serves the
// fixture at /ui/chat/dist/credentials-fixture-<hash>.html (mock data only).
import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = resolve(root, '../../../../data/dev-fixtures/credentials');
await mkdir(outdir, { recursive: true });
await copyFile(resolve(root, 'fixtures/credentials.html'), resolve(outdir, 'index.html'));

const options = {
  absWorkingDir: root,
  entryPoints: { app: 'fixtures/credentials.tsx' },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  loader: { '.ttf': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  outdir,
  logLevel: 'info',
};

if (process.argv.includes('--publish')) {
  const dist = resolve(root, 'dist');
  for (const name of await readdir(dist)) {
    if (name.startsWith('credentials-fixture-')) await rm(join(dist, name));
  }
  const result = await build({
    ...options,
    entryPoints: ['fixtures/credentials.tsx'],
    entryNames: 'credentials-fixture-[hash]',
    outdir: dist,
    sourcemap: false,
    metafile: true,
  });
  const entry = Object.entries(result.metafile.outputs).find(
    ([path, output]) => path.endsWith('.js') && output.entryPoint === 'fixtures/credentials.tsx',
  );
  if (!entry?.[1].cssBundle) throw new Error('Fixture JavaScript or CSS bundle is missing');
  const template = await readFile(resolve(root, 'fixtures/credentials.html'), 'utf8');
  const html = template.replace('./app.js', `./${basename(entry[0])}`).replace('./app.css', `./${basename(entry[1].cssBundle)}`);
  const name = `credentials-fixture-${createHash('sha256').update(html).digest('hex').slice(0, 12)}.html`;
  await writeFile(join(dist, name), html);
  console.log(`Fixture: /ui/chat/dist/${name}`);
} else if (process.argv.includes('--serve')) {
  const ctx = await context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: outdir, host: '127.0.0.1', port: Number(process.env.PORT || 4175) });
  console.log(`Credentials fixture: http://127.0.0.1:${port}/ (rebuilds on change; Ctrl-C to stop)`);
} else {
  await build(options);
  console.log(`Built ${outdir}. Serve it with: npm run fixture:credentials`);
}
