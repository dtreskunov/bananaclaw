import type { AppInfo, Connection, CredentialGroup, Service } from './CredentialsApi';

const PROVIDERS: Record<string, string> = {
  'openrouter.ai': 'OpenRouter',
  'ai-gateway.vercel.sh': 'Vercel AI Gateway',
  'api.anthropic.com': 'Anthropic',
  'api.openai.com': 'OpenAI',
  'api.minimax.io': 'MiniMax',
  'api.minimax.chat': 'MiniMax',
  'mcp.tavily.com': 'Tavily',
  'api.github.com': 'GitHub',
  'api.search.brave.com': 'Brave Search',
  'data.seattle.gov': 'Seattle Open Data',
};

export function serviceDestination(service: Service): string {
  return `https://${displayDestination(service.host + (service.path ?? ''))}`;
}

export function displayDestination(destination: string): string {
  return destination.replace(/^((?:https:\/\/)?(?:\[[^\]]+\]|[^/:]+)):443(?=\/|$)/i, '$1');
}

export function connectionName(
  connection: Pick<Connection, 'label' | 'services' | 'resource_url' | 'app_id'>,
  apps: AppInfo[] = [],
): string {
  if (connection.label && !/^(?:ag-[\w-]+\/|onecli-|(?:MCP|OAUTH|CONN)_)/i.test(connection.label))
    return connection.label;
  const app = apps.find((item) => item.id === connection.app_id);
  if (app?.label) return app.label[0].toUpperCase() + app.label.slice(1);
  if (connection.app_id) {
    if (connection.app_id === 'github') return 'GitHub';
    return connection.app_id[0].toUpperCase() + connection.app_id.slice(1);
  }
  const destination = connection.resource_url
    ? URL.parse(connection.resource_url)?.hostname
    : connection.services[0]?.host.split('/')[0].replace(/:\d+$/, '');
  return destination ? (PROVIDERS[destination] ?? destination) : 'Connection';
}

export function accessGroups(connections: Connection[], groups: CredentialGroup[]): CredentialGroup[] {
  const result = groups.filter(
    (group) =>
      group.canAdmin || connections.some((connection) => connection.grants.some((grant) => grant.vault === group.id)),
  );
  const unknown = new Set(
    connections
      .flatMap((connection) => connection.grants.map((grant) => grant.vault))
      .filter((id) => !result.some((group) => group.id === id)),
  );
  return [...result, ...[...unknown].map((id) => ({ id, name: 'Unavailable agent', canAdmin: false }))];
}
