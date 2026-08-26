import {create, toBinary} from '@bufbuild/protobuf';

import {decodeRealtimeEnvelope} from '@lib/impulse/realtime';
import {UpdatesSchema} from '@lib/impulse/grpc/gen/v1/types_pb';

describe('Impulse realtime envelope', () => {
  test('decodes the canonical Updates container published for a new message', () => {
    const container = create(UpdatesSchema, {
      value: {
        case: 'updates',
        value: {
          updates: [{
            value: {
              case: 'updateNewMessage',
              value: {
                message: {
                  value: {
                    case: 'message',
                    value: {
                      id: 41,
                      date: 1_777_298_044,
                      message: 'recipient realtime marker'
                    }
                  }
                },
                pts: 7,
                ptsCount: 1
              }
            }
          }],
          users: [],
          chats: [],
          date: 1_777_298_044,
          seq: 0
        }
      }
    });
    const data = bytesToBase64(toBinary(UpdatesSchema, container));

    const decoded = decodeRealtimeEnvelope({
      type: 100,
      pts: 7,
      ptsCount: 1,
      date: 1_777_298_044,
      data
    });

    expect(decoded).toMatchObject({
      _: 'updates',
      date: 1_777_298_044,
      seq: 0,
      updates: [{
        _: 'updateNewMessage',
        pts: 7,
        pts_count: 1,
        message: {
          _: 'message',
          id: 41,
          date: 1_777_298_044,
          message: 'recipient realtime marker'
        }
      }]
    });
  });
});

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for(const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
