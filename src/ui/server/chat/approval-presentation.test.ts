import { describe, expect, it } from 'vitest';
import { presentApproval } from './approval-presentation.js';

describe('approval presentation', () => {
  it('keeps requested packages grouped by package manager', () => {
    expect(
      presentApproval(
        'install_packages',
        JSON.stringify({
          apt: ['ffmpeg'],
          npm: ['playwright', '@scope/tool'],
          pip: ['yt-dlp'],
          reason: 'Build media previews',
        }),
      ),
    ).toEqual({
      details: 'Build media previews',
      packages: {
        apt: ['ffmpeg'],
        npm: ['playwright', '@scope/tool'],
        pip: ['yt-dlp'],
      },
    });
  });

  it('does not produce an empty package section', () => {
    expect(presentApproval('install_packages', JSON.stringify({ reason: 'No packages supplied' }))).toEqual({
      details: 'No packages supplied',
      packages: null,
    });
  });

  it('rejects malformed payload values from the presentation', () => {
    expect(
      presentApproval(
        'install_packages',
        JSON.stringify({ apt: ['curl', 42], npm: 'typescript', pip: [null], reason: 123 }),
      ),
    ).toEqual({
      details: null,
      packages: { apt: ['curl'], npm: [], pip: [] },
    });
  });
});
