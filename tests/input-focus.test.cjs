const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Use the actual input handlers, the real SessionStore that runs turns, and the
// pane that listens to it, with a synthetic host and a fake agent whose turns
// end when the test says. Browser checks also exercise native focus.
const component = fs.readFileSync('src/ui/ChatContainer.svelte', 'utf8');
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('ChatContainer.ts', script, ts.ScriptTarget.Latest, true);
const names = new Set(['handleSend', 'handleKeydown', 'keepFocus', 'resetHeight', 'closeMenus', 'setInputEnabled', 'focus', 'promptAnswer']);
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(declarations.length, names.size);
const handlers = ts.transpile(declarations.map(node => node.getText(ast).replace(/^export /, '')).join('\n'), { target: ts.ScriptTarget.ES2022 });
const cjs = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const storeCode = cjs('src/sessions.ts');
const viewCode = cjs('src/ui/chat-view.ts');

function load(code, modules) {
  const exports = {};
  vm.runInContext(code, vm.createContext({ exports, require(name) {
    if (name in modules) return modules[name];
    throw new Error('Unexpected import: ' + name);
  } }));
  return exports;
}

function fixture({ immediate = false } = {}) {
  let active = 'textarea', focusCalls = 0, saved = 0, pending;
  const turns = [], callbacks = [], notices = [], sent = [];

  // Each turn's run() waits for the test, unless `immediate`.
  class AgentLoop {
    run(_prompt, handlers) {
      callbacks.push(handlers);
      if (immediate) return Promise.resolve();
      return new Promise(resolve => turns.push(resolve));
    }
    abort() {} clear() {}
  }
  const { SessionStore } = load(storeCode, {
    obsidian: { App: class {} },
    './agent/loop': { AgentLoop, isTurnStart: () => true },
    './util/id': { uniqueId: prefix => prefix + Math.random().toString(36).slice(2) },
  });
  const store = new SessionStore({}, {});
  store.onChange = () => { saved++; };
  const session = store.create();

  const context = vm.createContext({
    inputText: '', inputEnabled: true, placeholder: 'Ask anything...', selection: null,
    awaitingAnswer: false, mention: null, command: null, menuOpen: false, dismissedStart: -1, commandDismissedAt: -1,
    fileLinkMenuEnabled: () => true,
    textareaEl: { style: {}, focus() { active = 'textarea'; focusCalls++; } },
    onSend: (text, selection) => { sent.push({ text, selection }); pending = view.handleUserMessage(text, selection); },
  });
  vm.runInContext(handlers, context);

  const noop = () => {};
  const { ObsidianChatView } = load(viewCode, {
    obsidian: { ItemView: class {}, Notice: function(text) { notices.push(text); } },
    svelte: { mount() {}, unmount() {} },
    './ChatContainer.svelte': {},
    '../skills/store': {},
    '../types': { resolveModel: () => '' },
    '../settings': { getModelDisplayName: () => '' },
    '../api/context-window': { onContextWindowsChange: () => noop },
    '../api/compaction': { contextBudget: () => 0 },
  });
  const view = new ObsidianChatView({}, { sessions: store, settings: {}, discardIfAbandoned() {} });
  view.chatContainer = {
    setInputEnabled: context.setInputEnabled, focus: context.focus, promptAnswer: context.promptAnswer,
    addUserMessage: noop, addAssistantMessage: noop, addError: noop, addNotice: noop,
    showThinking: noop, hideThinking: noop, clearMessages: noop, setSessions: noop, setTitle: noop,
    setContext: noop,
  };
  view.sessionId = session.id;
  view.unsubscribe = store.subscribe(session.id, event => view.applyEvent(event));

  return { context, view, store, session, turns, callbacks, sent, notices,
    get active() { return active; }, get focusCalls() { return focusCalls; }, get saved() { return saved; },
    moveFocus(target = 'other pane') { active = target; },
    send(text = 'hello') { context.inputText = text; context.handleSend(); return pending; },
    key(options) { const event = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, prevented: false,
      preventDefault() { this.prevented = true; }, ...options }; context.handleKeydown(event); return event; },
  };
}

for (const immediate of [true, false]) {
  test(`${immediate ? 'short' : 'delayed'} completion preserves deliberately moved focus and draft`, async () => {
    const f = fixture({ immediate });
    const pending = f.send();
    f.context.inputText = 'next draft';
    f.moveFocus();
    const focusBeforeCompletion = f.focusCalls;
    if (!immediate) f.turns[0]();
    await pending;
    assert.equal(f.active, 'other pane');
    assert.equal(f.focusCalls, focusBeforeCompletion);
    assert.equal(f.context.inputText, 'next draft');
    assert.equal(f.context.inputEnabled, true);
    assert.equal(f.saved, 1);
  });
}

test('explicit keyboard send restores textarea focus, then a busy Enter keeps its draft', async () => {
  const f = fixture();
  f.moveFocus('send button');
  const pending = f.send(' first ');
  assert.equal(f.active, 'textarea');
  assert.equal(f.sent[0].text, 'first');
  f.context.inputText = 'next draft';
  assert.equal(f.key({}).prevented, true);
  assert.equal(f.context.inputText, 'next draft');
  assert.equal(f.sent.length, 1);
  assert.equal(f.focusCalls, 1);
  assert.equal(f.key({ shiftKey: true }).prevented, false);
  f.turns[0]();
  await pending;
});

test('Stop focuses the input immediately; stale completion cannot take focus later', async () => {
  const f = fixture();
  const old = f.send();
  f.context.inputText = 'draft after stop';
  f.moveFocus('stop button');
  f.view.handleStop();
  assert.equal(f.active, 'textarea');
  assert.equal(f.context.inputText, 'draft after stop');
  assert.equal(f.context.inputEnabled, true);
  const focusAfterStop = f.focusCalls;
  f.moveFocus();
  f.turns[0]();
  await old;
  assert.equal(f.active, 'other pane');
  assert.equal(f.focusCalls, focusAfterStop);
});

test('Clear focuses the input', () => {
  const f = fixture();
  f.moveFocus('clear button');
  f.view.handleClear();
  assert.equal(f.active, 'textarea');
});

test('a stopped turn cannot unlock a new running turn', async () => {
  const f = fixture();
  const old = f.send('old');
  f.view.handleStop();
  const current = f.send('new');
  f.moveFocus();
  f.turns[0]();
  await old;
  assert.equal(f.context.inputEnabled, false);
  assert.equal(f.active, 'other pane');
  f.turns[1]();
  await current;
  assert.equal(f.context.inputEnabled, true);
  assert.equal(f.active, 'other pane');
});

for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`IME Enter remains untouched: ${JSON.stringify(options)}`, () => {
    const f = fixture();
    f.context.inputText = '候補';
    const e = f.key(options);
    assert.equal(e.prevented, false);
    assert.equal(f.context.inputText, '候補');
    assert.equal(f.sent.length, 0);
    assert.equal(f.focusCalls, 0);
  });
}

test('mouse/touch compatibility mousedown cancels only default focus movement', () => {
  const f = fixture();
  let prevented = false;
  f.context.keepFocus({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.active, 'textarea');
  assert.equal(f.sent.length, 0);
});

test('pending question cue follows the free-text answer lifecycle', async () => {
  const f = fixture();
  const pending = f.send('which one?');
  assert.equal(f.context.awaitingAnswer, false);
  const answer = f.callbacks[0].onAskUser('Which note?');
  assert.equal(f.context.awaitingAnswer, true);
  assert.equal(f.context.inputEnabled, true);
  assert.equal(f.context.placeholder, 'Type your answer...');
  f.moveFocus('send button');
  f.send(' the second note ');
  assert.equal(await answer, 'the second note');
  assert.equal(f.active, 'textarea');
  assert.equal(f.context.awaitingAnswer, false);
  assert.equal(f.context.inputEnabled, false);
  f.turns[0]();
  await pending;
  assert.equal(f.context.inputEnabled, true);
});

test('an answer leaves the selection for the next message', async () => {
  const f = fixture();
  const pending = f.send('which one?');
  const answer = f.callbacks[0].onAskUser('Which note?');
  const selection = { filePath: 'Note.md', text: 'picked' };
  f.context.selection = selection;
  f.send('this one');
  assert.equal(await answer, 'this one');
  assert.equal(f.sent[1].selection, null);
  assert.equal(f.context.selection, selection);
  f.turns[0]();
  await pending;
});

for (const cancel of ['handleStop', 'handleClear']) {
  test(`${cancel} releases a pending question and the next send starts a new turn`, async () => {
    const f = fixture();
    const pending = f.send('first');
    const answer = f.callbacks[0].onAskUser('Which note?');
    f.view[cancel]();
    assert.equal(await answer, '');
    assert.equal(f.context.awaitingAnswer, false);
    assert.equal(f.context.placeholder, 'Ask anything...');
    const next = f.send('new message');
    assert.equal(f.callbacks.length, 2);
    f.turns[0]();
    f.turns[1]();
    await Promise.all([pending, next]);
  });
}

test('closing the pane leaves a pending question with its session', async () => {
  const f = fixture();
  const pending = f.send('first');
  const answer = f.callbacks[0].onAskUser('Which note?');
  await f.view.onClose();
  assert.equal(f.session.pendingQuestion, 'Which note?');
  assert.equal(await f.store.run(f.session.id, 'that one', null), 'answered');
  assert.equal(await answer, 'that one');
  f.turns[0]();
  await pending;
});

test('a canceled question callback cannot disable the next turn’s pending answer', async () => {
  const f = fixture();
  const oldTurn = f.send('first prompt');
  const oldQuestion = f.callbacks[0].onAskUser('Which note first?');
  f.view.handleClear();

  // The first question's promise settles in a microtask. Start an independent
  // turn with its own question before that continuation runs.
  const newTurn = f.send('next prompt');
  const newQuestion = f.callbacks[1].onAskUser('Which note next?');
  assert.equal(await oldQuestion, '');
  assert.equal(f.context.inputEnabled, true);
  assert.equal(f.context.placeholder, 'Type your answer...');
  f.send('the second note');
  assert.equal(await newQuestion, 'the second note');
  assert.equal(f.context.inputEnabled, false);

  f.turns[0]();
  f.turns[1]();
  await Promise.all([oldTurn, newTurn]);
  assert.equal(f.context.inputEnabled, true);
});
