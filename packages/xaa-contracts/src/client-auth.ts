/**
 * RFC 6749 §2.3.1. `client_id` and `client_secret` are form-url-encoded *before*
 * they are joined by a colon and base64'd into the Basic header, because that is how
 * the Authorization Server takes them back apart.
 *
 * Sending the raw values works only for as long as neither contains a character the
 * decoder rewrites. These client secrets are `openssl rand -base64 48`, which carries
 * a `+` about two times in three, and a `+` decodes back as a space: the Human IdP
 * answered the Agent OP's authorization_code exchange with 401 invalid_client, and
 * consenting to `offline_access` ended on the "認可を完了できませんでした" page. The
 * Automation App's login never showed it only because its own secret happened to draw
 * no `+`, so this lives here rather than in either app — one encoding, one place, and
 * no third caller left to get it wrong.
 */
export function basicClientAuthHeader(clientId: string, clientSecret: string): string {
  const credentials = `${formUrlEncode(clientId)}:${formUrlEncode(clientSecret)}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

/**
 * `encodeURIComponent` leaves only unreserved characters alone, so every byte the
 * server's `decodeURIComponent` would act on is escaped first. A space becomes `%20`
 * rather than `+`; both round-trip, and `%20` cannot be mistaken for a literal plus.
 */
function formUrlEncode(value: string): string {
  return encodeURIComponent(value);
}
