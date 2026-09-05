/**
 * Why a consent came back and produced no agent.
 *
 * The page the person sees says only that it failed, and deliberately: the
 * Provisioner's refusals name a transaction and its owner, and a browser that followed
 * a redirect is not somewhere either belongs. The reason still has to go somewhere —
 * and until now it went nowhere. The comment above the failure page said the reason
 * stayed in the logs; no log was written. A consent that came back and failed produced
 * the same blank page whether the code had expired, the IdP connection was not usable,
 * or the agent's job could not be started, and there was no way to tell which.
 *
 * `reason` is the Provisioner's own error code where it sent one, and the transport's
 * message where the call never arrived. The one-time code is not a field here and must
 * not become one: it is a credential, and a log line is precisely the place it would
 * outlive its five minutes (RULE-38).
 */
export interface ConsentResumeFailure {
  transaction_id: string;
  human_subject: string;
  /** The Provisioner's status, or null when the call never got an answer. */
  status: number | null;
  reason: string;
}

export function logConsentResumeFailure(
  failure: ConsentResumeFailure,
  write: (line: string) => void = (line) => process.stdout.write(line),
): void {
  write(`${JSON.stringify({
    severity: 'ERROR',
    logType: 'xaa.consent_resume_failed',
    ...failure,
    occurred_at: new Date().toISOString(),
  })}\n`);
}
