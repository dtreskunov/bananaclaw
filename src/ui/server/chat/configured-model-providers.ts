import { listConnections } from '../../../modules/credentials/shared-connections.js';
import { connectionMatchesAccess } from '../../shared/access-authentication.js';
import { getModelConnection } from './model-connection.js';
import { listNativeModels, listOpenCodeModels, modelEndpoint, type ModelsDevFilter } from './models-dev-catalog.js';

export async function listConfiguredModelProviders(
  userId: string,
  provider: 'native' | 'opencode',
  filter: ModelsDevFilter,
  upstreamProvider?: string | null,
): Promise<string[]> {
  const connections = (await listConnections(userId)).filter((connection) => connection.status === 'ready');
  if (!connections.length) return [];
  const models = await (provider === 'native' ? listNativeModels(filter) : listOpenCodeModels(filter));
  if (!models) throw new Error('Model catalog unavailable');

  const configured = new Set<string>();
  const checked = new Set<string>();
  for (const model of models) {
    if (configured.has(model.upstream)) continue;
    const modelId = model.id.slice(model.upstream.length + 1);
    const endpoint = await modelEndpoint(model.upstream, modelId);
    // Models sharing an upstream endpoint have the same credential requirements.
    const key = JSON.stringify([model.upstream, endpoint]);
    if (checked.has(key)) continue;
    checked.add(key);
    const requirements = await getModelConnection(provider, model.id, upstreamProvider);
    if (requirements && connections.some((connection) => connectionMatchesAccess(connection, requirements))) {
      configured.add(model.upstream);
    }
  }
  return [...configured].sort();
}
