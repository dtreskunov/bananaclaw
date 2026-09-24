import { call, errMsg } from './components/GroupAdminApi';

export async function updateInstalledSkill(gid: string, slug: string): Promise<void> {
  const response = await call<{ skill?: { slug: string; commit: string }; error?: string }>(
    `/ui/chat/api/skills/${encodeURIComponent(slug)}/update`,
    'POST',
    { gid },
  );
  if (!response.ok) throw new Error(errMsg(response.data, `HTTP ${response.status}`));
  if (response.data.skill?.slug !== slug || !response.data.skill.commit) {
    throw new Error('Update response did not include the installed skill revision. Reload the skills list.');
  }
}
