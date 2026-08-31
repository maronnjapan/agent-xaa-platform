export const DEDICATED_OP_SA_ROLES = [
  'roles/cloudkms.signerVerifier',
  'roles/cloudkms.cryptoKeyEncrypterDecrypter',
  'roles/datastore.user',
  'roles/storage.objectCreator',
  'roles/pubsub.publisher',
] as const;

export const DEDICATED_AGENT_SA_ROLES = [
  'roles/run.invoker',
  'roles/run.invoker',
  'roles/run.invoker',
  'roles/aiplatform.user',
  'roles/datastore.user',
  'roles/pubsub.publisher',
] as const;
