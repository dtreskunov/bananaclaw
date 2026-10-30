export interface ServiceDestination {
  host: string;
  path?: string;
  https_only?: boolean;
  enabled?: boolean;
}

export function serviceMatchesResource(service: ServiceDestination, resourceUrl: string): boolean {
  const url = URL.parse(resourceUrl);
  if (!url || service.enabled === false || (service.https_only && url.protocol !== 'https:')) return false;
  const slash = service.host.indexOf('/');
  const authority = slash < 0 ? service.host : service.host.slice(0, slash);
  const path = service.path ?? (slash < 0 ? undefined : service.host.slice(slash));
  const separator = authority.lastIndexOf(':');
  const explicitPort = separator >= 0 && /^\d+$/.test(authority.slice(separator + 1));
  const host = explicitPort ? authority.slice(0, separator) : authority;
  if (explicitPort && authority.slice(separator + 1) !== (url.port || (url.protocol === 'https:' ? '443' : '80')))
    return false;
  const glob = (pattern: string, value: string): boolean =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value);
  return glob(host.toLowerCase(), url.hostname.toLowerCase()) && (!path || glob(path, url.pathname));
}
