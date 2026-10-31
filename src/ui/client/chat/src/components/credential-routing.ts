import { CredentialsError, serviceKeys, type Service } from './CredentialsApi';
import { serviceDestination } from './credential-presentation';
import type { AccessRequirements } from '../../../../shared/access-authentication';
import { serviceMatchesResource } from '../../../../shared/credential-matching';

export interface RouteDraft {
  service: Service;
  pattern: string;
}

export function accessCreationDefaults(
  request: AccessRequirements,
  apps: { id: string; api_hosts: string[]; default_scopes: string[] }[],
): {
  kind: 'static' | 'mcp_oauth' | 'oauth_app';
  appId: string;
  scopes: string[];
  routes: RouteDraft[];
} {
  const hint = request.authentication;
  const oauthScopes = !!request.scopes?.length && (!hint || hint.type === 'bearer');
  const kind =
    hint?.type === 'mcp_oauth' || hint?.type === 'oauth_app'
      ? hint.type
      : (!hint || oauthScopes) && request.mcp_server
        ? 'mcp_oauth'
        : oauthScopes
          ? 'oauth_app'
          : 'static';
  const candidates = apps.filter((app) =>
    app.api_hosts.some((host) => serviceMatchesResource({ host, https_only: true }, request.resource_url)),
  );
  const app = hint?.app_id
    ? apps.find((app) => app.id === hint.app_id)
    : kind === 'oauth_app' && candidates.length === 1
      ? candidates[0]
      : undefined;
  const routes = routingDrafts();
  routes[0].pattern = request.resource_url;
  if (kind === 'static' && hint) {
    routes[0].service.auth = authentication(hint.type, { type: 'unset' }, []);
    if (hint.type === 'api-key')
      routes[0].service.auth =
        hint.location === 'query'
          ? { type: 'api-key', key: routes[0].service.auth.key, location: 'query', parameter: hint.parameter }
          : { ...routes[0].service.auth, header: hint.header, prefix: hint.prefix };
    if (hint.type === 'custom')
      routes[0].service.auth.headers = Object.fromEntries(
        (hint.headers ?? []).map((header, index) => [header, `{{ HEADER_VALUE_${index + 1} }}`]),
      );
  }
  return { kind, appId: app?.id ?? '', scopes: request.scopes ?? app?.default_scopes ?? [], routes };
}

export function parseUrlPattern(value: string): { host: string; hostname: string } {
  const text = value.trim();
  const source = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  const url = URL.parse(source);
  if (
    !text ||
    !url ||
    url.protocol !== 'https:' ||
    !url.hostname ||
    /\s/.test(text) ||
    url.username ||
    url.password ||
    source.includes('?') ||
    source.includes('#')
  )
    throw new CredentialsError('Enter an HTTPS URL pattern without credentials, query parameters or a fragment.');
  const authority = source.slice(source.indexOf('://') + 3);
  return { host: url.host + (authority.includes('/') ? url.pathname : ''), hostname: url.hostname };
}

export function hostnameFromPattern(value: string): string {
  const text = value.trim();
  const url = URL.parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  return url?.protocol === 'https:' && !url.username && !url.password ? url.hostname : '';
}

export function oauthResourceUrl(value: string): string {
  const text = value.trim();
  const source = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  const url = URL.parse(source);
  if (
    !text ||
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.host.includes('*') ||
    url.pathname.includes('*')
  )
    throw new CredentialsError('Enter an HTTPS MCP URL without wildcards, embedded credentials or a fragment.');
  return source;
}

export function routingDrafts(services?: Service[]): RouteDraft[] {
  return (
    services?.length
      ? services
      : [
          {
            name: 'route-1',
            host: '',
            https_only: true,
            auth: { type: 'bearer', token: 'TOKEN' },
          },
        ]
  ).map((service) => ({
    service: structuredClone(service),
    pattern: service.host ? serviceDestination(service) : '',
  }));
}

export function unusedKey(keys: string[], prefix: string): string {
  let key = prefix;
  let index = 2;
  while (keys.includes(key)) key = `${prefix}_${index++}`;
  return key;
}

export function authentication(
  type: string,
  previous: Service['auth'],
  keys: string[],
  preferredKey?: string,
): Service['auth'] {
  if (type === previous.type) return structuredClone(previous);
  switch (type) {
    case 'bearer':
      return { type, token: previous.token ?? previous.key ?? preferredKey ?? unusedKey(keys, 'TOKEN') };
    case 'api-key':
      return {
        type,
        key: previous.key ?? previous.token ?? preferredKey ?? unusedKey(keys, 'API_KEY'),
        header: 'X-Api-Key',
      };
    case 'basic':
      return { type, username: unusedKey(keys, 'USERNAME'), password: unusedKey(keys, 'PASSWORD') };
    case 'custom':
      return { type, headers: { 'X-Api-Key': `{{ ${unusedKey(keys, 'HEADER_VALUE')} }}` } };
    default:
      throw new CredentialsError('Choose an authentication method.');
  }
}

export function sharedAuthentication(services: Service[]): boolean {
  const recipe = (service: Service): string => {
    const auth = service.auth;
    return JSON.stringify([
      auth.type,
      auth.token,
      auth.key,
      auth.username,
      auth.password,
      auth.type === 'api-key' ? (auth.location ?? 'header') : auth.location,
      auth.type === 'api-key' && auth.location !== 'query'
        ? (auth.header || 'Authorization').toLowerCase()
        : auth.header,
      auth.parameter,
      auth.prefix ?? '',
      Object.entries(auth.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      service.substitutions ?? [],
    ]);
  };
  return services.every((service) => recipe(service) === recipe(services[0]));
}

export function compileRoutes(routes: RouteDraft[], auth?: Service['auth']): Service[] {
  if (!routes.length) throw new CredentialsError('Add a URL pattern.');
  if (!auth && !sharedAuthentication(routes.map((route) => route.service)))
    throw new CredentialsError('All destinations must share the credential authentication.');
  const names = new Set<string>();
  return routes.map(({ service: original, pattern }) => {
    const service = auth ? { ...original, auth: structuredClone(auth), substitutions: undefined } : original;
    const parsed = parseUrlPattern(pattern);
    if (!service.name || names.has(service.name)) throw new CredentialsError('Duplicate URL routing entry.');
    names.add(service.name);
    const headerName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
    const query = service.auth.type === 'api-key' && service.auth.location === 'query';
    if (
      service.auth.type === 'api-key' &&
      service.auth.location &&
      !['header', 'query'].includes(service.auth.location)
    )
      throw new CredentialsError('Choose header or query placement.');
    if (
      query &&
      (!/^[A-Za-z0-9._~-]{1,128}$/.test(service.auth.parameter ?? '') || service.auth.header || service.auth.prefix)
    )
      throw new CredentialsError('Enter the query parameter name without a header or prefix.');
    if (service.auth.type === 'api-key' && !query && !headerName.test(service.auth.header ?? ''))
      throw new CredentialsError('Enter the API-key header name.');
    if (service.auth.prefix && /[\r\n]/.test(service.auth.prefix))
      throw new CredentialsError('Header prefixes cannot contain line breaks.');
    if (service.auth.type === 'custom') {
      if (!Object.keys(service.auth.headers ?? {}).length) throw new CredentialsError('Add a header.');
      for (const [name, value] of Object.entries(service.auth.headers ?? {}))
        if (!headerName.test(name) || /[\r\n]/.test(value))
          throw new CredentialsError('Enter valid header names and values without line breaks.');
    }
    const placeholders = new Set<string>();
    for (const substitution of service.substitutions ?? []) {
      if (
        !/^[A-Za-z0-9_.~-]{4,128}$/.test(substitution.placeholder) ||
        !/[A-Za-z0-9]/.test(substitution.placeholder) ||
        placeholders.has(substitution.placeholder)
      )
        throw new CredentialsError(
          'Use distinct placeholders of 4–128 letters, digits, underscores, dots, tildes or hyphens.',
        );
      placeholders.add(substitution.placeholder);
      if (substitution.in && !substitution.in.length)
        throw new CredentialsError('Choose where to replace each placeholder.');
    }
    if (!serviceKeys([service]).length) throw new CredentialsError('Add a credential value.');
    return { ...service, host: parsed.host, path: undefined, https_only: true };
  });
}

export function credentialFields<T extends Pick<Service, 'auth' | 'substitutions'>>(
  services: T[],
): { key: string; label: string }[] {
  const labels = new Map<string, string>();
  for (const service of services) {
    const auth = service.auth;
    if (auth.token && !labels.has(auth.token)) labels.set(auth.token, 'Token');
    if (auth.key && !labels.has(auth.key)) labels.set(auth.key, 'API key');
    if (auth.username && !labels.has(auth.username)) labels.set(auth.username, 'Username');
    if (auth.password && !labels.has(auth.password)) labels.set(auth.password, 'Password');
    for (const [header, template] of Object.entries(auth.headers ?? {}))
      for (const match of template.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g))
        if (!labels.has(match[1])) labels.set(match[1], `${header || 'Header'} value`);
    for (const substitution of service.substitutions ?? [])
      if (!labels.has(substitution.key)) labels.set(substitution.key, 'Saved value');
  }
  const duplicates = new Map<string, number>();
  return [...labels].map(([key, label]) => {
    const count = (duplicates.get(label) ?? 0) + 1;
    duplicates.set(label, count);
    return { key, label: count === 1 ? label : `${label} ${count}` };
  });
}
