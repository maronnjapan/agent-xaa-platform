/**
 * The `client_assertion_type` an Agent presents to its own OP.
 *
 * It is the RFC 7523 value, not a platform invention: the Agent OP authenticates
 * the agent by a JWT signed with the Agent Client Credential, and nothing else.
 * Kept in its own module so the Runtime that sends it and the OP that checks it
 * cannot drift apart through a copied literal.
 */
export { CLIENT_ASSERTION_TYPE as AGENT_CLIENT_AUTH_ASSERTION_TYPE } from './grant-types.js';
