import {create, toBinary, fromBinary} from '@bufbuild/protobuf';
import {describe, expect, it} from 'vitest';

import {buildProtoInit, protoToTL} from '../lib/impulse/grpc/adapter';
import {ReplyMarkupSchema} from '../lib/impulse/grpc/gen/v1/types_pb';


/**
 * Layer 229 flattened the reply keyboards: a KeyboardButton is `{style, text, type}` where `type`
 * is a ButtonType union, and an inline markup carries KeyboardInlineButtonRow rows whose buttons
 * carry an InlineButtonType union. Both must survive the bridge in both directions.
 */
describe('gRPC adapter keyboard buttons (layer 229)', () => {
  it('round-trips a flat reply keyboard button with its type union and style', () => {
    const tl = {
      _: 'replyKeyboardMarkup',
      pFlags: {resize: true},
      rows: [{
        _: 'keyboardButtonRow',
        buttons: [
          {_: 'keyboardButton', text: 'plain', type: {_: 'buttonTypeDefault'}},
          {
            _: 'keyboardButton',
            text: 'poll',
            style: {_: 'keyboardButtonStyle', bg_primary: true},
            type: {_: 'buttonTypeRequestPoll', quiz: true}
          }
        ]
      }]
    };

    const message = create(ReplyMarkupSchema, buildProtoInit(tl, ReplyMarkupSchema));
    const back = protoToTL(fromBinary(ReplyMarkupSchema, toBinary(ReplyMarkupSchema, message)), ReplyMarkupSchema);

    expect(back._).toBe('replyKeyboardMarkup');
    const [plain, poll] = back.rows[0].buttons;
    expect(plain).toMatchObject({_: 'keyboardButton', text: 'plain', type: {_: 'buttonTypeDefault'}});
    expect(poll).toMatchObject({
      _: 'keyboardButton',
      text: 'poll',
      style: {_: 'keyboardButtonStyle', pFlags: {bg_primary: true}},
      type: {_: 'buttonTypeRequestPoll', quiz: true}
    });
  });

  it('round-trips an inline markup with retyped rows and an inline button type union', () => {
    const tl = {
      _: 'replyInlineMarkup',
      rows: [{
        _: 'keyboardInlineButtonRow',
        buttons: [
          {_: 'keyboardInlineButton', text: 'open', type: {_: 'inlineButtonTypeUrl', url: 'https://example.org'}}
        ]
      }]
    };

    const message = create(ReplyMarkupSchema, buildProtoInit(tl, ReplyMarkupSchema));
    const back = protoToTL(fromBinary(ReplyMarkupSchema, toBinary(ReplyMarkupSchema, message)), ReplyMarkupSchema);

    expect(back._).toBe('replyInlineMarkup');
    expect(back.rows[0]._).toBe('keyboardInlineButtonRow');
    expect(back.rows[0].buttons[0]).toMatchObject({
      _: 'keyboardInlineButton',
      text: 'open',
      type: {_: 'inlineButtonTypeUrl', url: 'https://example.org'}
    });
  });
});
