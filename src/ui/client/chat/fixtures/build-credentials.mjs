// Builds the credentials settings fixture into fixtures/.build.
// `--serve` rebuilds on change and serves it on 127.0.0.1 (PORT, default 4175).
// Fixture builds never modify deployed dist/ assets.
import { build, context } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = resolve(root, 'fixtures/.build');
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

if (process.argv.includes('--serve')) {
  const ctx = await context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: outdir, host: '127.0.0.1', port: Number(process.env.PORT || 4175) });
  console.log(`Credentials fixture: http://127.0.0.1:${port}/ (rebuilds on change; Ctrl-C to stop)`);
} else {
  await build(options);
  console.log(`Built ${outdir}. Serve it with: npm run fixture:credentials`);
}
