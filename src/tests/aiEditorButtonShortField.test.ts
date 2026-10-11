import {createRoot} from 'solid-js';
import {useAiEditorButton} from '@components/richMessageInput/ai';
import type {AiEditorContext} from '@components/richMessageInput/aiContext';
import type InputField from '@components/inputField';
import type {MessageEntity} from '@layer';

const mocks = vi.hoisted(() => ({
  resize: undefined as undefined | ((entry: {contentRect: {height: number}}) => void)
}));

vi.mock('@components/buttonTsx', () => ({default: (props: {class: string}) => {
  const button = document.createElement('button');
  button.className = props.class;
  return button;
}}));
vi.mock('@components/chat/createAiEditorIcon', () => ({default: () => document.createElement('span')}));
vi.mock('@components/resizeObserver', () => ({observeResize: (_element: Element, callback: typeof mocks.resize) => {
  mocks.resize = callback;
  return () => {};
}}));
vi.mock('@lib/solidjs/hotReloadGuard', () => ({useHotReloadGuard: () => ({
  rootScope: {managers: {acknowledged: {aiTonesManager: {getTones: vi.fn()}}}},
  toastNew: vi.fn(),
  HotReloadGuard: undefined as undefined
})}));

vi.mock('@helpers/dom/getRichValueWithCaret', () => ({
  default: (input: HTMLElement) => ({value: input.textContent, entities: [] as MessageEntity[]})
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while(disposers.length) disposers.pop()!();
  document.body.replaceChildren();
  mocks.resize = undefined;
});

function mountCaptionAiButton(): {container: HTMLDivElement, sendButton: HTMLButtonElement} {
  const container = document.createElement('div');
  const input = document.createElement('div');
  const sendButton = document.createElement('button');
  sendButton.className = 'simple-message-input-confirm';
  container.append(input, sendButton);
  document.body.append(container);

  const context: AiEditorContext = {
    capture: () => ({peerId: 42, isCurrent: () => true, clear: vi.fn()})
  };

  createRoot((dispose) => {
    disposers.push(dispose);
    useAiEditorButton({
      context,
      inputField: () => ({input} as unknown as InputField),
      container: () => container,
      appendTo: () => container,
      onApply: vi.fn(),
      canSend: false,
      shouldShowFromHeight: () => 100,
      insertBefore: () => sendButton
    });
  });

  return {container, sendButton};
}

function aiButtonOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('.chat-input-ai-editor-button');
}

test('a caption shorter than the threshold hides the AI editor button inline, not via the hidden attribute', () => {
  const {container} = mountCaptionAiButton();
  mocks.resize?.({contentRect: {height: 48}});

  const button = aiButtonOf(container);
  expect(button).not.toBeNull();
  expect(button!.style.display).toBe('none');
});

test('a caption at the threshold shows the AI editor button', () => {
  const {container} = mountCaptionAiButton();
  mocks.resize?.({contentRect: {height: 120}});

  const button = aiButtonOf(container);
  expect(button).not.toBeNull();
  expect(button!.style.display).toBe('');
});

test('a caption at the threshold places the AI editor button before the send button, with no offset that could cover it', () => {
  const {container, sendButton} = mountCaptionAiButton();
  mocks.resize?.({contentRect: {height: 120}});

  const button = aiButtonOf(container)!;
  const children = Array.from(container.children);
  expect(children.indexOf(button)).toBeLessThan(children.indexOf(sendButton));
  expect(button.nextElementSibling).toBe(sendButton);
  expect(button.style.right).toBe('');
  expect(button.style.position).toBe('');
});
