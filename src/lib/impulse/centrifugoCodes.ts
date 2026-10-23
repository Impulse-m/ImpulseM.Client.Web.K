/** The server code of a token the server refused as expired: the token a connection or a call presented. */
export const TOKEN_EXPIRED_CODE: number = 109;
/** The server code of a token it refused as invalid: revoked, consumed, or not allowed for the method. */
export const AUTH_TOKEN_INVALID_CODE: number = 103;
export const METHOD_INVALID_CODE: number = 104;

/** Whether the server refused the token a connection or a call presented. */
export function isTokenRefusalCode(code: number | undefined): boolean {
  return code === TOKEN_EXPIRED_CODE || code === AUTH_TOKEN_INVALID_CODE;
}
