import type { Es256Signer, JtiStore } from '@xaa/crypto';
import type { DocumentStore } from '@xaa/gcp';
import type { AgentOpConfig } from './config.js';
import type { JwksSource } from './keys/shared-jwks.js';
import type { EnvelopeCipher } from './idp-connection/crypto.js';
import type { ActivityPublisher } from './log/protocol-violation-event.js';

export interface AgentOpDeps {
  config: AgentOpConfig;
  documents: DocumentStore;
  jtiStore: JtiStore;
  signer: Es256Signer;
  jwksSource: JwksSource;
  envelope: EnvelopeCipher;
  publisher: ActivityPublisher;
  /** Cloud Run revision name; reported as op_runtime_id in the exchange log. */
  revision: string;
  now?: () => number;
  /** Test seams for the two structured log sinks. */
  writeExchangeLog?: (line: string) => void;
  writeLedger?: (line: string) => void;
  writeConnectionLog?: (line: string) => void;
  /** Token endpoint of Human IdP, called with a stored refresh token. */
  humanIdpFetch?: typeof fetch;
}
