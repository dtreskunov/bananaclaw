/**
 * Catalogs offered as one-click suggestions in the admin UI.
 *
 * Deliberately short and curated rather than seeded automatically: adding a
 * catalog clones a repo, so it stays an operator decision. This list only
 * removes the "what do I even type here" problem — every entry was verified to
 * be readable by `marketplace.ts`, either through a plugin manifest or the
 * plain `skills/<slug>/SKILL.md` fallback.
 */
export interface SuggestedCatalog {
  repo: string;
  ref: string;
  label: string;
  description: string;
}

export const SUGGESTED_CATALOGS: SuggestedCatalog[] = [
  {
    repo: 'anthropics/skills',
    ref: 'main',
    label: 'Anthropic Agent Skills',
    description:
      "Anthropic's example skills plus the document skills (docx, pdf, pptx, xlsx). Most are Apache-2.0; the four document skills are source-available, not open source.",
  },
  {
    repo: 'anthropics/knowledge-work-plugins',
    ref: 'main',
    label: 'Anthropic Knowledge Work Plugins',
    description: 'Partner plugin bundles aimed at knowledge work, published by Anthropic.',
  },
  {
    repo: 'openai/skills',
    ref: 'main',
    label: 'OpenAI Skills Catalog',
    description: "OpenAI's skills catalog for Codex. No plugin manifest — read via the plain skills/ layout.",
  },
  {
    repo: 'vercel-labs/skills',
    ref: 'main',
    label: 'Vercel Labs Skills',
    description: 'Skills from Vercel Labs, including the find-skills discovery helper.',
  },
];
