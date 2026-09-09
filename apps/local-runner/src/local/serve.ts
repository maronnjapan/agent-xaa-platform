import { serve, type ServerType } from '@hono/node-server';

export interface Listener {
  name: string;
  url: string;
  close(): Promise<void>;
}

/**
 * One service on one port.
 *
 * A real socket rather than `app.fetch`, because the platform's services address each
 * other by URL and a browser addresses three of them directly: the OAuth redirects
 * between the Automation App, the Human IdP and the Agent OP callback are the flow
 * being reproduced, and a flow that never left the process would not be it.
 */
export function listen(input: { name: string; host: string; port: number; fetch: (request: Request) => Response | Promise<Response> }): Listener {
  const server: ServerType = serve({
    fetch: input.fetch,
    port: input.port,
    hostname: input.host,
  });
  return {
    name: input.name,
    url: `http://${input.host}:${input.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
