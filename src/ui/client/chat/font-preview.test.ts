import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const preview = fs.readFileSync(new URL('./dist/airy-font-preview.html', import.meta.url), 'utf8');
const compactPreview = fs.readFileSync(new URL('./dist/compact-font-preview.html', import.meta.url), 'utf8');
const builtCss = fs.readFileSync(new URL('./dist/app.css', import.meta.url), 'utf8');
const chatPackage = fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8');
const chatRoutes = fs.readFileSync(new URL('../../server/chat/routes.ts', import.meta.url), 'utf8');

describe('blind font preview', () => {
  it('keeps typography choices in CSS variables', () => {
    for (const token of ['--sample-size', '--sample-weight', '--sample-tracking', '--sample-line-height']) {
      expect(preview).toContain(token);
    }
    expect(preview).toContain("style.setProperty('--sample-weight', weight)");
    expect(preview).toContain("style.setProperty('--sample-tracking', `${tracking}em`)");
    expect(preview).toContain("style.setProperty('--sample-line-height', lineHeight)");
  });

  it('swaps A and B in one sample slot at every viewport size', () => {
    expect(preview).toContain('id="show-a"');
    expect(preview).toContain('id="show-b"');
    expect(preview).toContain('#candidate { grid-template-columns: 1fr;');
    expect(preview).toContain('#candidate[data-sample="a"] .option:nth-child(2)');
    expect(preview).toContain('#candidate[data-sample="b"] .option:nth-child(1)');
    expect(preview).toContain("get('#candidate').dataset.sample = visibleSample");
    expect(preview).toContain("get('#show-a').setAttribute('aria-pressed', String(visibleSample === 'a'))");
    expect(preview).toContain("get('#show-b').setAttribute('aria-pressed', String(visibleSample === 'b'))");
  });

  it('runs font selection before adaptive one-variable typography tuning', () => {
    expect(preview).toContain("stage: 'font'");
    expect(preview).toContain("state.stage = 'variables'");
    expect(preview).toContain("state.stage = 'complete'");
    expect(preview).toContain('Choose a font below to begin stage 2');
    expect(preview).toContain('VARIABLE_DEFINITIONS[state.variables.activeIndex]');
    expect(preview).toContain('next.activeIndex = (next.activeIndex + 1) % VARIABLE_DEFINITIONS.length');
    expect(preview).toContain('The preferred value becomes the incumbent.');
  });
});

describe('Compact typography preview', () => {
  it('keeps Figtree fixed and tunes one Compact variable at a time', () => {
    expect(compactPreview).toContain('Figtree is fixed.');
    expect(compactPreview).toContain('"Figtree", system-ui, sans-serif');
    expect(compactPreview).toContain('next.activeIndex = (next.activeIndex + 1) % DEFINITIONS.length');
    expect(compactPreview).toContain('A preferred challenger becomes the incumbent');
  });

  it('shows the pre-Figtree Compact settings as a static reference', () => {
    expect(compactPreview).toContain('id="reference-card"');
    expect(compactPreview).toContain('The pre-Figtree look');
    expect(compactPreview).toContain(
      `const INITIAL_SETTINGS = { size: '14', weight: '400', tracking: '0', lineHeight: '1.4' }`,
    );
    expect(compactPreview).toContain(`'"Avenir Next", "Segoe UI", system-ui, sans-serif'`);
    expect(compactPreview).toContain("get('#reference-card').replaceChildren(makeCard('R', INITIAL_SETTINGS, true))");
  });

  it('uses an independent durable study state and one visible A/B sample', () => {
    expect(compactPreview).toContain('nanoclaw:compact-typography-study:v1');
    expect(compactPreview).toContain('.candidate[data-sample="a"] .option:nth-child(2)');
    expect(compactPreview).toContain('.candidate[data-sample="b"] .option:nth-child(1)');
    expect(compactPreview).toContain('localStorage.setItem(STORAGE_KEY, JSON.stringify(state))');
  });
});

describe('Figtree production assets', () => {
  it('bundles every required weight and serves only generated Figtree assets from the nested font path', () => {
    expect(chatPackage).toContain('--loader:.ttf=file');
    expect(chatPackage).toContain('--asset-names=fonts/[name]-[hash]');
    for (const weight of ['300', '400', '500']) {
      expect(builtCss).toContain(`font-weight: ${weight}`);
      expect(builtCss).toMatch(new RegExp(`fonts/figtree-${weight}-[A-Z0-9]{8}\\.ttf`));
    }
    expect(chatRoutes).toContain('/^figtree-(300|400|500)-[A-Z0-9]{8}\\.ttf$/');
    expect(chatRoutes).toContain("? 'font/ttf'");
  });
});
