import {DcAuthKey, DcServerSalt, TrueDcId} from '@types';

export type ActiveAccountNumber = 1 | 2 | 3 | 4;

type A = Record<DcAuthKey, string> &
  Record<DcServerSalt, string> &
  {
    auth_key_fingerprint: string,
    push_key?: string,
    push_key_fingerprint?: string,
    userId: PeerId,
    dcId: TrueDcId,
    date: number,
    // Bearer token for the ImpulseM gateway. MTProto carried identity in the
    // auth key; the gRPC transport needs it as an explicit header.
    impulse_session_token?: string,
    impulse_refresh_token?: string,
    // Opaque, short-lived pending-2FA identity (auth.signIn's SESSION_PASSWORD_NEEDED trailer,
    // #675) — canon's auth-key-bound password_pending state (api/auth.md:816-830) has no
    // transport equivalent here, so this substitutes for it between the challenge and
    // auth.checkPassword. Never a session: restoreImpulseSession must not derive userId from it.
    impulse_pending_token?: string
  };

export type AccountSessionData = Partial<A>;
