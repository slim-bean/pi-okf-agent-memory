import { EventEmitter } from 'node:events';

export function createHarness(extension, cwd, { hasUI = true, mode = 'tui', extensionFactory = extension } = {}) {
  const tools = {}, commands = {}, hooks = {}, messages = [], prompts = [], notices = [], statuses = new Map(), widgets = new Map(), confirmations = [];
  const emitter = new EventEmitter(), entries = [], hostResponses = [], hostReady = [], maintenance = [];
  const events = { emit: (name, data) => { emitter.emit(name, data); }, on: (name, handler) => { emitter.on(name, handler); return () => emitter.off(name, handler); } };
  events.on('okf:upgrade:response', data => hostResponses.push(data));
  events.on('okf:upgrade:ready', data => hostReady.push(data));
  events.on('okf:upgrade:maintenance', data => maintenance.push(data));
  const ctx = { cwd, mode, hasUI, isIdle: () => true, hasPendingMessages: () => false, branch: [], sessionManager: { getBranch: () => ctx.branch }, ui: {
    notify: (...args) => notices.push(args),
    setStatus: (key, value) => statuses.set(key, value),
    setWidget: (key, value) => widgets.set(key, value),
    confirm: async (...args) => { confirmations.push(args); return ctx.approve; },
  }, approve: false };
  extensionFactory({
    events, appendEntry: (customType, data) => entries.push({ customType, data }),
    getActiveTools: () => ctx.activeTools ?? Object.keys(tools),
    registerTool: def => tools[def.name] = def,
    registerCommand: (name, def) => commands[name] = def.handler,
    on: (name, handler) => { (hooks[name] ??= []).push(handler); },
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage: text => prompts.push(text),
  });
  return { tools, commands, hooks, messages, prompts, notices, statuses, widgets, confirmations, ctx, events, entries, hostResponses, hostReady, maintenance,
    async emit(name, event = {}) { const results = []; for (const hook of hooks[name] ?? []) results.push(await hook(event, ctx)); return results; },
    command(args = '') { return commands['memory-upgrade'](args, ctx); },
    async call(name, params = {}) {
      for (const hook of hooks.turn_start ?? []) await hook({}, ctx);
      return tools[name].execute('test', params, undefined, undefined, ctx);
    },
  };
}

export async function waitFor(predicate, message = 'condition', timeout = 5000) {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
