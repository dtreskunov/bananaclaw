import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('technical status UI', () => {
  it('gates every transcript status surface while preserving essential live state and outcomes', () => {
    const source = fs.readFileSync(new URL('./src/components/ChatMain.tsx', import.meta.url), 'utf8');

    expect(source.match(/appearance\.value\.preferences\.showTechnicalStatus/g)).toHaveLength(4);
    expect(source.match(/showTechnicalDetails=\{showTechnicalStatus\}/g)).toHaveLength(2);
    expect(source.match(/count=\{showTechnicalStatus \?/g)).toHaveLength(3);
    expect(source).toContain('showStop ? <span class="msg-inline-actions turn-stop-inline">');
    expect(source).toContain('showTechnicalStatus && (status || lines.length)');
    expect(source).toContain('showOutcomeNote && view.note');
  });
});
