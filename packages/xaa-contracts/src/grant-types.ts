export {
  JWT_BEARER_GRANT_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  ID_JAG_TOKEN_TYPE,
  TOKEN_TYPE_ID_TOKEN,
  TOKEN_TYPE_JWT,
  TOKEN_TYPE_REFRESH_TOKEN,
} from '@maronn-openid-connect/experimental/id-jag';
import { TOKEN_TYPE_REFRESH_TOKEN } from '@maronn-openid-connect/experimental/id-jag';

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const REJECTED_SUBJECT_TOKEN_TYPES = [TOKEN_TYPE_REFRESH_TOKEN] as const;
