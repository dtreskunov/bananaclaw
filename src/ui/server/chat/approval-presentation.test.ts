import { describe, expect, it } from 'vitest';
import { presentApproval } from './approval-presentation.js';

describe('approval presentation', () => {
  it('uses Tools in access requests without changing the requested destination', () => {
    expect(
      presentApproval('request_access', {
        reason: 'Read the report',
        resource_url: 'https://example.com/mcp',
        mcp_server: 'SnapTrade',
      }),
    ).toEqual({
      details: 'Read the report\nhttps://example.com/mcp\nTools: SnapTrade',
      packages: null,
    });
  });
  it('presents new tools without exposing transport terminology', () => {
    expect(
      presentApproval('add_mcp_server', { name: 'SnapTrade', url: 'https://example.com/mcp', transport: 'http' }),
    ).toEqual({
      details: 'SnapTrade tools · https://example.com/mcp',
      packages: null,
    });
  });
  it('keeps requested packages grouped by package manager', () => {
    expect(
      presentApproval('install_packages', {
        apt: ['ffmpeg'],
        npm: ['playwright', '@scope/tool'],
        pip: ['yt-dlp'],
        reason: 'Build media previews',
      }),
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
    expect(presentApproval('install_packages', { reason: 'No packages supplied' })).toEqual({
      details: 'No packages supplied',
      packages: null,
    });
  });

  it('rejects malformed payload values from the presentation', () => {
    expect(
      presentApproval('install_packages', { apt: ['curl', 42], npm: 'typescript', pip: [null], reason: 123 }),
    ).toEqual({
      details: null,
      packages: { apt: ['curl'], npm: [], pip: [] },
    });
  });
});
