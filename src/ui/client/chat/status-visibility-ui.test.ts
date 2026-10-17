import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('technical status UI', () => {
  it('gates every transcript status surface while preserving essential live state and outcomes', () => {
    const source = fs.readFileSync(new URL('./src/components/ChatMain.tsx', import.meta.url), 'utf8');

    expect(source.match(/appearance\.value\.preferences\.showTechnicalStatus/g)).toHaveLength(3);
    // Replies, display cards and the live turn row each gate their technical details.
    expect(source.match(/\{showTechnicalStatus\s*\?\s*<TurnTechnicalDetails/g)).toHaveLength(3);
    // Live status, Stop and elapsed time stay visible without technical information.
    expect(source).toContain('if (!status && !showTechnicalStatus) return null;');
    expect(source).toMatch(/\{presentation\.stopControl\}\s*\{presentation\.elapsedControl\}/);
    expect(source).toContain('headline && showTechnicalStatus\n          ? <button');
    expect(source).toContain('headline ? <span class="hint">');
  });
});
