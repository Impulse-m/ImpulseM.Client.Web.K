import type {DataJSON} from '@layer';
import type {CallId} from '@appManagers/appCallsManager';
import type {GroupCallId} from '@appManagers/appGroupCallsManager';
import jwtClaims from '@helpers/jwtClaims';


export type LiveKitJoinParams = {
  url: string,
  token: string,
  room: string,
  /** Unix seconds from the token's `exp` claim; diagnostics only, the token is never verified here. */
  expiresAt?: number
};

export type LiveKitParamsErrorCode = 'LIVEKIT_PARAMS_MISSING' | 'LIVEKIT_PARAMS_INVALID' | 'LIVEKIT_ROOM_MISMATCH';

export class LiveKitParamsError extends Error {
  public readonly code: LiveKitParamsErrorCode;

  constructor(code: LiveKitParamsErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'LiveKitParamsError';
    this.code = code;
  }
}

/** Room of a 1:1 call: `p.{callId}`, the id as the decimal string the server minted it from. */
export function phoneCallRoomName(callId: CallId): string {
  return `p.${callId}`;
}

/** Room of a group call: `g.{callId}`. */
export function groupCallRoomName(callId: GroupCallId): string {
  return `g.${callId}`;
}

/**
 * Parses the coordinates the backend hands out in `DataJSON.data`:
 * `{"livekit":{"url","token","room"}}`.
 *
 * Missing params, or no `livekit` key, is MISSING. Unparsable JSON, a non-string or empty
 * field, or a url that is not ws/wss is INVALID. A room other than `expectedRoom` is
 * ROOM_MISMATCH. There is no fallback to any other transport.
 */
export function parseLiveKitJoinParams(options: {
  params: DataJSON | undefined,
  expectedRoom: string
}): LiveKitJoinParams {
  const {params, expectedRoom} = options;
  const data: unknown = params?.data;
  if(typeof data !== 'string' || !data) {
    throw new LiveKitParamsError('LIVEKIT_PARAMS_MISSING', 'the call carries no connection parameters');
  }

  let document: unknown;
  try {
    document = JSON.parse(data);
  } catch{
    throw new LiveKitParamsError('LIVEKIT_PARAMS_INVALID', 'connection parameters are not JSON');
  }

  if(!isRecord(document)) {
    throw new LiveKitParamsError('LIVEKIT_PARAMS_INVALID', 'connection parameters are not an object');
  }

  if(!('livekit' in document) || document.livekit === undefined || document.livekit === null) {
    throw new LiveKitParamsError('LIVEKIT_PARAMS_MISSING', 'connection parameters carry no livekit section');
  }

  const section: unknown = document.livekit;
  if(!isRecord(section)) {
    throw new LiveKitParamsError('LIVEKIT_PARAMS_INVALID', 'the livekit section is not an object');
  }

  const url: string = readString(section, 'url');
  const token: string = readString(section, 'token');
  const room: string = readString(section, 'room');

  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch{
    throw new LiveKitParamsError('LIVEKIT_PARAMS_INVALID', 'url is not a valid URL');
  }

  if(protocol !== 'ws:' && protocol !== 'wss:') {
    throw new LiveKitParamsError('LIVEKIT_PARAMS_INVALID', 'url is not a ws/wss url');
  }

  if(room !== expectedRoom) {
    throw new LiveKitParamsError('LIVEKIT_ROOM_MISMATCH', `expected room ${expectedRoom}, got ${room}`);
  }

  const result: LiveKitJoinParams = {url, token, room};
  const expiresAt: number | undefined = jwtClaims(token)?.exp;
  if(expiresAt !== undefined) {
    result.expiresAt = expiresAt;
  }

  return result;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, field: string): string {
  const value: unknown = source[field];
  if(typeof value !== 'string' || !value) {
    throw new LiveKitParamsError('LIVEKIT_PARAMS_INVALID', `${field} is not a non-empty string`);
  }

  return value;
}
