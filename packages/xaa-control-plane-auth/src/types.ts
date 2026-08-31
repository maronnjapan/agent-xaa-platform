export interface VerifiedAccessToken {
  sub: string;
  aud: string | string[];
  scope: string[];
  cnf: { jkt: string };
  jti: string;
}

export type ControlPlaneVariables = {
  accessToken: VerifiedAccessToken;
  humanSubject: string;
  validatedBody: Record<string, unknown>;
  dpop: { jti: string; jkt: string };
};
