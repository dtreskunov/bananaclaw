import { describe, expect, it } from 'vitest';

import { parseSkillFrontmatter, validateSkillFrontmatter } from './frontmatter.js';

function fm(body: string): string {
  return `---\n${body}\n---\n\n# Body\n`;
}

describe('parseSkillFrontmatter', () => {
  it('parses the spec fields', () => {
    const parsed = parseSkillFrontmatter(
      fm(
        'name: pdf\ndescription: Work with PDFs.\nlicense: Apache-2.0\nallowed-tools: Bash(pdftk:*), Read\ncompatibility: needs python',
      ),
    );
    expect(parsed).toMatchObject({
      name: 'pdf',
      description: 'Work with PDFs.',
      license: 'Apache-2.0',
      allowedTools: ['Bash(pdftk:*)', 'Read'],
      compatibility: 'needs python',
      offSpecKeys: [],
    });
  });

  it('collapses folded descriptions to a single line', () => {
    const parsed = parseSkillFrontmatter(fm('name: x\ndescription: >-\n  first\n  second'));
    expect(parsed!.description).toBe('first second');
  });

  it('prefers metadata.requires_env over the legacy top-level key', () => {
    expect(parseSkillFrontmatter(fm('name: x\ndescription: d\nmetadata:\n  requires_env: NEW'))!.requiresEnv).toBe(
      'NEW',
    );
    expect(parseSkillFrontmatter(fm('name: x\ndescription: d\nrequires_env: OLD'))!.requiresEnv).toBe('OLD');
    expect(
      parseSkillFrontmatter(fm('name: x\ndescription: d\nrequires_env: OLD\nmetadata:\n  requires_env: NEW'))!
        .requiresEnv,
    ).toBe('NEW');
  });

  it('returns null without frontmatter or on unparseable YAML', () => {
    expect(parseSkillFrontmatter('# no frontmatter')).toBeNull();
    expect(parseSkillFrontmatter('---\nname: x\n')).toBeNull();
    expect(parseSkillFrontmatter(fm('name: [unclosed'))).toBeNull();
  });
});

describe('validateSkillFrontmatter', () => {
  it('accepts a conforming skill', () => {
    const parsed = parseSkillFrontmatter(fm('name: pdf\ndescription: Work with PDFs.'));
    expect(validateSkillFrontmatter(parsed, 'pdf')).toEqual({ errors: [], warnings: [] });
  });

  it('rejects a missing description and a non-kebab name', () => {
    expect(validateSkillFrontmatter(parseSkillFrontmatter(fm('name: pdf')), 'pdf').errors).toEqual([
      'frontmatter is missing `description`',
    ]);
    expect(
      validateSkillFrontmatter(parseSkillFrontmatter(fm('name: My_Skill\ndescription: d')), 'my-skill').errors,
    ).toHaveLength(1);
  });

  it('warns about off-spec keys and folder/name mismatch', () => {
    const parsed = parseSkillFrontmatter(fm('name: other\ndescription: d\ncolor: blue'));
    const { errors, warnings } = validateSkillFrontmatter(parsed, 'mine');
    expect(errors).toEqual([]);
    expect(warnings.join(' ')).toContain('off-spec frontmatter key: color');
    expect(warnings.join(' ')).toContain('does not match the folder name');
  });
});
