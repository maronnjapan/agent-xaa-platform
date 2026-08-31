import type { DocumentStore } from '@xaa/gcp';
import type { AgentOpConfig } from '../config.js';
import { AgentRegistrationRepository } from './agent-registration-repository.js';
import { IdpConnectionRepository } from './idp-connection-repository.js';
import { IssuerProfileRepository } from './issuer-profile-repository.js';
import { XaaConfigRepository } from './xaa-config-repository.js';

export { AgentRegistrationRepository, IdpConnectionRepository, IssuerProfileRepository, XaaConfigRepository };
export type { AgentRegistration, IdpConnection, IssuerProfile, XaaStaticConfiguration } from './types.js';

export interface AgentOpStore {
  registrations: AgentRegistrationRepository;
  xaaConfigs: XaaConfigRepository;
  idpConnections: IdpConnectionRepository;
  issuerProfiles: IssuerProfileRepository;
}

/** The raw Firestore handle stays inside; only the four repositories escape. */
export function createAgentOpStore(documents: DocumentStore, config: AgentOpConfig, kid: () => string): AgentOpStore {
  return {
    registrations: new AgentRegistrationRepository(documents),
    xaaConfigs: new XaaConfigRepository(documents),
    idpConnections: new IdpConnectionRepository(documents),
    issuerProfiles: new IssuerProfileRepository(config, kid),
  };
}
