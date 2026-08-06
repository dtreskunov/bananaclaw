// Brand strings exposed by the server via a `<script>` tag in index.html
// (see src/ui/server/branding.ts -> brandBootstrapScript). Falls back to
// the stock NanoClaw brand if the bootstrap is missing (e.g. during
// stand-alone client dev).
interface BrandGlobal {
  name?: string;
  shortName?: string;
  description?: string;
  themeColor?: string;
  backgroundColor?: string;
}

const g = (globalThis as unknown as { __BRAND__?: BrandGlobal }).__BRAND__ ?? {};

export const BRAND = {
  name: g.name || 'NanoClaw',
  shortName: g.shortName || g.name || 'NanoClaw',
  description: g.description || '',
  themeColor: g.themeColor || '#151515',
  backgroundColor: g.backgroundColor || '#0d1117',
};
