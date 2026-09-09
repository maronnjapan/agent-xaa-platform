import { loadConfig } from '@xaa/agent-op/src/config';
import type { RunningService } from '../local/cloud-run.js';
import { listen } from '../local/serve.js';
import type { LocalPlatform } from '../platform.js';
import { createAgentOpApp } from './agent-op.js';

/**
 * Hands out the ports Dedicated Agent OPs listen on.
 *
 * Cloud Run assigns a hostname; here the equivalent scarce thing is a port, and it is
 * handed back when the service is deleted so a platform that provisions and destroys
 * isolated agents all day does not walk off the end of the range.
 */
export function createPortPool(base: number, size = 100): { take(): number; give(port: number): void } {
  const free = Array.from({ length: size }, (_, index) => base + index);
  return {
    take() {
      const port = free.shift();
      if (port === undefined) throw new Error('no port is free for another Dedicated Agent OP');
      return port;
    },
    give(port) { free.push(port); },
  };
}

/**
 * A `full_isolation` agent's own Agent OP, started on demand.
 *
 * This is what `createService` means locally. The environment arrives from the
 * Provisioner with the agent's id and its two key names already in it, and the only
 * thing added here is `PUBLIC_BASE_URL` — which the deployed Provisioner has to patch in
 * afterwards, because Cloud Run does not tell it the URL until the service exists. The
 * OP that results is the same app the shared one runs, bound to one agent, signing with
 * its own key under its own kid.
 */
export function createDedicatedOpStarter(platform: LocalPlatform): (input: { name: string; env: Record<string, string>; agentId: string }) => Promise<RunningService> {
  const ports = createPortPool(platform.config.topology.dedicatedPortBase);
  return async (input) => {
    const port = ports.take();
    const publicBaseUrl = `http://${platform.config.topology.host}:${port}`;
    try {
      const app = await createAgentOpApp(platform, loadConfig({ ...input.env, PUBLIC_BASE_URL: publicBaseUrl }));
      const listener = listen({
        name: input.name,
        host: platform.config.topology.host,
        port,
        fetch: app.fetch,
      });
      return {
        uri: publicBaseUrl,
        async stop() {
          await listener.close();
          // The key goes with the service: a kid left in the aggregate set would
          // still verify grants signed by an OP nobody can reach any more.
          platform.jwks.remove(app.kid);
          ports.give(port);
        },
      };
    } catch (error) {
      ports.give(port);
      throw error;
    }
  };
}
