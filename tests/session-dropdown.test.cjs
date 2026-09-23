const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// The header dropdown's change handler from ChatContainer, wired to the real
// pane's selectSession, with a stub plugin that says which chats other panes show.
const component = fs.readFileSync('src/ui/ChatContainer.svelte', 'utf8');
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('ChatContainer.ts', script, ts.ScriptTarget.Latest, true);
const handler = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleSessionChange');
const handlerCode = ts.transpile(handler.getText(ast), { target: ts.ScriptTarget.ES2022 });
const viewCode = ts.transpileModule(fs.readFileSync('src/ui/chat-view.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture({ shownElsewhere = [] } = {}) {
  const revealed = [];
  const exports = {};
  vm.runInContext(viewCode, vm.createContext({ exports, require(name) {
    // Only the base class matters here; nothing else the module imports runs.
    if (name === 'obsidian') return { ItemView: class {}, Notice: function() {} };
    return {};
  } }));
  const plugin = {
    sessions: { get: id => ({ id, running: false }) },
    openSessionIds: () => new Set(shownElsewhere),
    revealSession: id => { revealed.push(id); return Promise.resolve(null); },
  };
  const view = new exports.ObsidianChatView({}, plugin);
  view.sessionId = 'mine';
  const context = vm.createContext({ activeSessionId: 'mine', onSelectSession: id => view.selectSession(id) });
  vm.runInContext(handlerCode, context);
  const pick = id => {
    const select = { value: id };
    context.handleSessionChange({ currentTarget: select });
    return select.value;
  };
  return { pick, revealed };
}

test('picking a chat no other pane shows keeps it in the dropdown', () => {
  const f = fixture();
  assert.equal(f.pick('other'), 'other');
  assert.deepEqual(f.revealed, ['other']);
});

test('picking a chat another pane shows reveals that pane and puts this dropdown back', () => {
  const f = fixture({ shownElsewhere: ['other'] });
  assert.equal(f.pick('other'), 'mine');
  assert.deepEqual(f.revealed, ['other']);
});
