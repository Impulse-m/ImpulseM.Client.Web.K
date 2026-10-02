import type {UserFull} from '@layer';

/**
 * Whether the Call (voice) or Video call button is offered for a user: exactly what the server says in
 * `userFull.phone_calls_available` / `video_calls_available`. Nothing is inferred on the client; a missing
 * profile offers nothing.
 */
export default function isCallAvailable(userFull: Pick<UserFull, 'pFlags'> | undefined, type: 'voice' | 'video'): boolean {
  if(!userFull) {
    return false;
  }

  return !!(type === 'voice' ? userFull.pFlags.phone_calls_available : userFull.pFlags.video_calls_available);
}
