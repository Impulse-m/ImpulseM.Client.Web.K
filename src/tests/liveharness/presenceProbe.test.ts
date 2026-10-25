import {describe, expect, it} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';

import {UpdatesSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import type {PublicationRecord} from './realtimeWire';
import {decodePresenceEnvelopes} from './presenceProbe';

const OWNER_KEY: string = '42';

describe('presence probe reads the status an updateShort carries', () => {
  it('finds the owner updateUserStatus carried as the single update of an updateShort', async() => {
    const bytes: Uint8Array = toBinary(UpdatesSchema, create(UpdatesSchema, {
      value: {
        case: 'updateShort',
        value: {
          date: 1,
          update: {
            value: {
              case: 'updateUserStatus',
              value: {userId: BigInt(OWNER_KEY), status: {value: {case: 'userStatusOnline', value: {expires: 1}}}}
            }
          }
        }
      }
    }));
    const record: PublicationRecord = {
      channel: `user:${OWNER_KEY}`,
      envelope: {type: 1, data: bytes},
      receivedAtMs: 0
    };

    const result = await decodePresenceEnvelopes([record], OWNER_KEY);

    expect(result.matches.map((match) => match.statusName)).toEqual(['userStatusOnline']);
  });
});
