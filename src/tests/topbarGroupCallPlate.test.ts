/*
 * The video chat bar under a group's header for a member that is not in the call. It shows while the
 * call has somebody in it (tdesktop history_view_group_call_bar.cpp:409), and the call this tab is
 * leaving stays its own until the leave's answer is applied (tdesktop calls_group_call.cpp:2247-2254),
 * so leaving a call never flashes the bar of the call just left.
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {JSX, createSignal} from 'solid-js';
import {render} from 'solid-js/web';
import '@helpers/peerIdPolyfill';
import {ChatType} from '@components/chat/chatType';
import type {GroupCall} from '@layer';

type CurrentCall = {chatId: ChatId, leaveSettled: Promise<void>} | undefined;

const mocks = vi.hoisted(() => ({
  renderPlate: undefined as (() => JSX.Element) | undefined,
  setHidden: vi.fn(),
  getGroupCallPreview: vi.fn(),
  listeners: new Map<string, Set<(arg: unknown) => void>>(),
  current: undefined as (() => unknown) | undefined,
  chat: undefined as (() => unknown) | undefined
}));

vi.mock('@components/chat/topbarPlate', () => ({
  default: {
    ActionButton: (props: {children: unknown}) => props.children
  },
  createTopbarPlate: (options: {render: (controls: {setHidden: (hidden: boolean) => void}) => JSX.Element}) => {
    mocks.renderPlate = () => options.render({setHidden: mocks.setHidden});
    return {
      container: document.createElement('div'),
      destroy: vi.fn(),
      isHidden: vi.fn(),
      setHidden: mocks.setHidden
    };
  }
}));

vi.mock('@components/chat/topbarGroupCall/topbarGroupCall', () => ({
  TopbarGroupCall: (): JSX.Element => null
}));

vi.mock('@components/groupCall/hooks', () => ({
  useCurrentGroupCall: () => mocks.current
}));

vi.mock('@stores/peers', () => ({
  useChat: () => mocks.chat
}));

vi.mock('@stores/fullPeers', () => ({
  useFullPeer: () => () => ({_: 'chatFull', call: {_: 'inputGroupCall', id: 'call', access_hash: 'hash'}})
}));

vi.mock('@lib/rootScope', () => ({
  default: {
    managers: {appGroupCallsManager: {getGroupCallPreview: mocks.getGroupCallPreview}},
    addEventListener: (name: string, callback: (arg: unknown) => void) => {
      if(!mocks.listeners.has(name)) mocks.listeners.set(name, new Set());
      mocks.listeners.get(name).add(callback);
    },
    removeEventListener: (name: string, callback: (arg: unknown) => void) => {
      mocks.listeners.get(name)?.delete(callback);
    }
  }
}));

vi.mock('@lib/appImManager', () => ({default: {joinGroupCall: vi.fn()}}));
vi.mock('@lib/langPack', () => ({i18n: (key: string) => document.createTextNode(key)}));

import createChatGroupCallPlate from '@components/chat/topbarGroupCall/container';

const CHAT_ID = 5 as ChatId;

function activeCall(participantsCount: number): GroupCall.groupCall {
  return {
    _: 'groupCall',
    pFlags: {},
    id: 'call',
    access_hash: 'hash',
    participants_count: participantsCount,
    unmuted_video_limit: 0,
    version: 1
  };
}

function preview(participantsCount: number) {
  return {call: activeCall(participantsCount), peerIds: [] as PeerId[]};
}

function dispatch(name: string, arg: unknown) {
  mocks.listeners.get(name)?.forEach((callback) => callback(arg));
}

async function settle() {
  for(let i = 0; i < 5; ++i) {
    await Promise.resolve();
  }
}

function mount(current: CurrentCall) {
  const [currentCall, setCurrentCall] = createSignal<CurrentCall>(current);
  mocks.current = currentCall;
  mocks.chat = () => ({_: 'chat', id: CHAT_ID, pFlags: {call_active: true, call_not_empty: true}});
  const plate = createChatGroupCallPlate(
    {setFloating: vi.fn()} as any,
    {type: ChatType.Chat} as any,
    {} as any
  );
  const dispose = render(() => mocks.renderPlate!(), document.createElement('div'));
  plate.setPeerId(CHAT_ID.toPeerId(true));
  return {setCurrentCall, dispose};
}

function shownStates(): boolean[] {
  return mocks.setHidden.mock.calls.map(([hidden]) => !hidden);
}

function lastShown(): boolean {
  const states = shownStates();
  return states[states.length - 1];
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.renderPlate = undefined;
});

describe('the video chat bar of a group', () => {
  it('shows a call somebody is in to a member that is not in it', async() => {
    mocks.getGroupCallPreview.mockResolvedValue(preview(1));
    const {dispose} = mount(undefined);
    try {
      await settle();
      expect(lastShown()).toBe(true);
    } finally {
      dispose();
    }
  });

  it('never shows the call this tab is leaving, and stays hidden once nobody is left in it', async() => {
    let applyLeave: () => void;
    const leaveSettled = new Promise<void>((resolve) => applyLeave = resolve);
    mocks.getGroupCallPreview.mockResolvedValue(preview(1));
    const {setCurrentCall, dispose} = mount({chatId: CHAT_ID, leaveSettled});
    try {
      await settle();
      expect(lastShown(), 'the bar of the call this tab is in').toBe(false);

      setCurrentCall(undefined);
      await settle();
      expect(shownStates(), 'the call is left but the answer is not applied: it still counts this account').not.toContain(true);

      mocks.getGroupCallPreview.mockResolvedValue(preview(0));
      dispatch('group_call_update', activeCall(0));
      applyLeave();
      await settle();

      expect(
        shownStates(),
        'the leave is applied and nobody is in the call, while the chat still says call_not_empty'
      ).not.toContain(true);
    } finally {
      dispose();
    }
  });
});
