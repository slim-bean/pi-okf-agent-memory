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

/** Build fixtures through the native store with the argument shape the old CLI fixtures used. */
export function makeCli(memory) {
  const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  return (command, ...args) => {
    if (command === 'init') return memory.initBundle(args[0]);
    if (command === 'create' || command === 'update') {
      const [id, bundle] = args;
      const tags = flag(args, '--tags');
      return memory.writeConcept(bundle, { id, type: flag(args, '--type'), title: flag(args, '--title') ?? (command === 'create' ? id.split('/').at(-1) : undefined),
        description: flag(args, '--desc') ?? (command === 'create' ? `About ${id}.` : undefined), body: flag(args, '--body'), status: flag(args, '--status'),
        tags: tags === undefined ? undefined : tags.split(',').filter(Boolean), actor: 'agent/cli' });
    }
    if (command === 'relate') {
      const [from, to, bundle] = args;
      const up = from.split('/').slice(0, -1).map(() => '..').join('/');
      return memory.writeConcept(bundle, { id: from, append: `# Related Concepts\n- [${to}](${up ? up + '/' : ''}${to}.md): ${flag(args, '--desc') ?? 'related'}`, actor: 'agent/cli' });
    }
    throw new Error(`Unsupported fixture command: ${command}`);
  };
}
/** A model-reviewed upgrade step for exercising the review workflow; shipped steps are automatic. */
export function reviewSteps(validateBundle) {
  return [{ id: '001-validation-contract', title: 'Review the memory contract', instructions: '001-validation-contract.md',
    verify(bundle) { const result = validateBundle(bundle); if (!result.ok) throw new Error(`Upgrade verification failed; progress was not advanced.\n${JSON.stringify(result.findings)}`); } }];
}
