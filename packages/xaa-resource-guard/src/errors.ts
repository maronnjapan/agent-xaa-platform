export class ResourceProtectionError extends Error {
  constructor(public readonly code: 'invalid_token' | 'insufficient_scope') {
    super('resource request was not authorized');
  }
}
