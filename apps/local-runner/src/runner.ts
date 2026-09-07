import { loadConfig as loadAgentOpConfig } from '@xaa/agent-op/src/config';
import type { VertexClient } from '@xaa/vertex';
import { loadLocalConfig, type LocalRunnerConfig, type SeedMode } from './config.js';
import { createLocalRunPlatform, type LocalRunPlatform } from './local/cloud-run.js';
import type { Listener } from './local/serve.js';
import { createLocalPlatform, installLogSink, TOPICS, type LocalPlatform } from './platform.js';
import { runLocalSeed } from './seed.js';
import { startAgentOp } from './services/agent-op.js';
import { startAgentRuntimeExecution } from './services/agent-runtime.js';
import { startAnalysisConsole } from './services/analysis-console.js';
import { startAuthorization } from './services/authorization.js';
import { startAutomationApp } from './services/automation-app.js';
import { createDedicatedOpStarter } from './services/dedicated-op.js';
import { startGoogleBridge } from './services/google-bridge.js';
import { startHumanIdp } from './services/human-idp.js';
import { startLifecycle, startLifecycleTick } from './services/lifecycle.js';
import { startPlatformConfig } from './services/platform-config.js';
import { startProvisioner } from './services/provisioner.js';
import { endAgentsFromPreviousRun } from './services/recover.js';
import { startResource } from './services/resource.js';
import { startSecurityDetection } from './services/security-detection.js';

export interface RunningPlatform {
  platform: LocalPlatform;
  run: LocalRunPlatform;
  listeners: Listener[];
  stop(): Promise<void>;
}

/**
 * Builds the platform and opens every port, in the order the dependencies require.
 *
 * The order is not arbitrary. The platform config service goes first because it serves
 * the JWK Set every other service verifies against; the Human IdP goes next because
 * publishing its SSO key into that set is what makes a login verifiable anywhere else;
 * the seed goes last, once the endpoints it resolves its placeholders against are real
 * addresses.
 */
export async function startLocalPlatform(
  config: LocalRunnerConfig = loadLocalConfig(),
  /** Test seam: a model built by the caller rather than from the environment. */
  overrides: { model?: VertexClient } = {},
): Promise<RunningPlatform> {
  const platform = await createLocalPlatform(config, overrides);
  installLogSink(platform);

  const run = createLocalRunPlatform({
    projectId: config.topology.projectId,
    region: config.topology.region,
    jwks: platform.jwks,
    startService: createDedicatedOpStarter(platform),
    startExecution: (input) => startAgentRuntimeExecution(platform, input),
  });

  const listeners: Listener[] = [startPlatformConfig(platform)];
  listeners.push(await startHumanIdp(platform));
  listeners.push(await startAgentOp(platform, 'token', loadAgentOpConfig));
  listeners.push(await startAgentOp(platform, 'callback', loadAgentOpConfig));
  listeners.push(...await startResource(platform, 'docs'));
  listeners.push(...await startResource(platform, 'finance'));
  listeners.push(startAuthorization(platform));
  listeners.push(startProvisioner(platform, run));
  const lifecycle = startLifecycle(platform, run);
  listeners.push(lifecycle.listener);
  listeners.push(startAutomationApp(platform));
  listeners.push(startAnalysisConsole(platform));
  listeners.push(startSecurityDetection(platform));
  if (config.topology.bridgeEnabled) listeners.push(...startGoogleBridge(platform));

  // The two push subscriptions Terraform declares, pointed at the ports above. They
  // are registered after the services exist so a delivery cannot arrive at a socket
  // that is not open yet.
  const pushToken = (audience: string) => platform.identity.mint(audience, platform.accounts.pubsubPush!);
  platform.pubsub.pushSubscription(TOPICS.activity, {
    endpoint: `${config.topology.url['automation-app']}/internal/activity/push`,
    audience: config.topology.url['automation-app'],
    token: pushToken,
  });
  platform.pubsub.pushSubscription(TOPICS.permissionChanged, {
    endpoint: `${config.topology.url.authorization}/internal/events/human-permission-changed`,
    audience: config.topology.url.authorization,
    token: pushToken,
  });

  // Both of these need the ports above to be open: the seed resolves its placeholders
  // against real addresses, and ending an agent means calling the OP that issues for it.
  if (shouldSeed(config.seed, platform.state.fresh)) await runLocalSeed(platform);
  const ended = platform.state.fresh ? [] : await endAgentsFromPreviousRun(platform, lifecycle.cleanup);
  const tick = startLifecycleTick(platform);
  if (!config.quiet) printBanner(config, listeners, ended.length);

  return {
    platform,
    run,
    listeners,
    async stop() {
      tick.stop();
      // Deliveries first: a subscriber whose socket closed underneath it would report
      // a failed push for an event that was only ever going to arrive a moment late.
      await platform.pubsub.drain();
      await run.stopAll();
      for (const listener of listeners) await listener.close();
      await platform.shutdown();
    },
  };
}

/**
 * Whether this run writes the seed.
 *
 * `auto` reads the state because the seed replaces the catalogue, the capability
 * taxonomy and every `human_permissions` row: on a platform that carried its rows over
 * it would undo the permissions an administrator granted since the last start. There is
 * nothing to undo on a run that starts from nothing, which is when it writes.
 */
export function shouldSeed(mode: SeedMode, fresh: boolean): boolean {
  if (mode === 'never') return false;
  return mode === 'always' || fresh;
}

/** The login the guide prints, and the addresses to open. */
function printBanner(config: LocalRunnerConfig, listeners: readonly Listener[], endedAgents: number): void {
  const { url } = config.topology;
  const provider = config.model.provider === 'fake'
    ? 'fake (no model is called; set MODEL_PROVIDER to change that)'
    : [
      config.model.provider,
      config.model.provider === 'cli' ? ` (${config.model.cliCommand ?? config.model.cliPreset ?? 'claude-code'})` : '',
      config.model.model ? ` / ${config.model.model}` : '',
    ].join('');
  process.stdout.write([
    '',
    '  Agent XAA Platform is running locally.',
    '',
    `    Automation App     ${url['automation-app']}`,
    `    Analysis Console   ${url['analysis-console']}`,
    `    Human IdP          ${url['human-idp']}`,
    '',
    '    Sign in as         testuser / password',
    `    Model              ${provider}`,
    `    Services           ${listeners.length} listening${config.topology.bridgeEnabled ? ' (Google Bridge on)' : ''}`,
    `    State              ${config.stateDir ?? 'in memory (LOCAL_PERSIST=false)'}`,
    '',
    ...(endedAgents > 0
      ? [`  ${String(endedAgents)} agent(s) from the previous run were ended: an agent's credentials do not outlive its process.`, '']
      : []),
    ...(config.stateDir === undefined
      ? ['  Stopping this process discards every agent, ToDo and document.', '']
      : []),
  ].join('\n'));
}
