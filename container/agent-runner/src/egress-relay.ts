/**
 * Egress relay for credential-gateway containers.
 *
 * HTTP clients can only use a TCP proxy URL, but the gateway is reachable only
 * through the per-session Unix socket the host mounts. This relay listens on
 * 127.0.0.1 and pipes each connection to that socket unchanged; the gateway
 * does all proxy work. Off when NANOCLAW_EGRESS_SOCKET is unset (OneCLI groups).
 *
 * Bun (1.3) closes a TCP connection fully when either side sends FIN, so a
 * client that half-closes before reading its reply loses it. HTTP and TLS
 * clients don't do that.
 */
import net from 'node:net';

export const EGRESS_RELAY_PORT = 3128;

export async function startEgressRelay(
  socketPath: string | undefined = process.env.NANOCLAW_EGRESS_SOCKET,
  port: number = EGRESS_RELAY_PORT,
): Promise<net.Server | null> {
  if (!socketPath) return null;
  const server = net.createServer((client) => {
    const upstream = net.connect({ path: socketPath });
    // Idle keep-alive connections must not keep a finished process alive
    // (e.g. the MCP probe after it prints its result).
    client.unref();
    upstream.unref();
    const destroy = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', destroy);
    upstream.on('error', destroy);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Never keep a finished process (e.g. the MCP probe) alive.
  server.unref();
  return server;
}
