export type JwtClaims = {
  sub?: string,
  exp: number,
  iat?: number,
  orig_iat?: number
};


export default function jwtClaims(token: string): JwtClaims | undefined {
  const segments: string[] = token.split('.');
  if(segments.length !== 3) {
    return undefined;
  }
  try {
    const base64: string = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded: string = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    if(typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
      'exp' in payload && typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
      return payload as JwtClaims;
    }
  } catch{
    return undefined;
  }
  return undefined;
}
