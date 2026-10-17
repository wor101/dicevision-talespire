// Unit tests for symbiote/app.js, run with `node tests/app.test.mjs`.
// app.js is a browser script, so it's loaded into a vm context with just
// enough stand-ins (no Talespire, no DOM).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { existsSync } from 'node:fs';

const source = readFileSync(new URL('../symbiote/app.js', import.meta.url), 'utf8');
const context = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {} }, window: {}, setTimeout, clearTimeout, setInterval, clearInterval });
const app = vm.runInContext(`${source}
;({ DiceVisionBridge, UIController, describeError, inRangeForDie, readDice, escapeHtml, faceNumber, displayFace, summarizeDice, formatDiceString, convertToTalespireFormat, sendToTalespire, parseStoredState, campaignStore, notifyOutsidePanel })`, context);

let passes = 0;
let failures = 0;
function check(cond, msg) {
  if (cond) passes++;
  else { failures++; console.error(`  FAIL: ${msg}`); }
}
async function test(name, fn) {
  const before = failures;
  try { await fn(); } catch (err) { failures++; console.error(`  FAIL: threw ${err.stack}`); }
  console.log(`${failures === before ? 'ok  ' : 'FAIL'} ${name}`);
}

/** A die as the server sends it: {type, value, face, readable} */
const vtt = (type, face, readable = true) => {
  const n = app.faceNumber(face);
  return { type, value: readable && n !== null ? n : -1, face, readable };
};

/** A connected bridge whose sent messages and callbacks are recorded. */
function bridge({ continuous = false, once = false } = {}) {
  const b = new app.DiceVisionBridge();
  const log = { sent: [], rolls: [], unusable: [] };
  b.isConnected = () => true;
  b.send = msg => log.sent.push(msg.type);
  b.onRoll = roll => log.rolls.push(roll);
  b.onUnusableRoll = (roll, unreadable, waiting) => log.unusable.push({ roll, unreadable, waiting });
  b.continuousMode = continuous;
  b.pendingRollOnce = once;
  b.isWaiting = continuous || once;
  return { b, log };
}

await test('faceNumber and readDice read every server shape', () => {
  check(app.faceNumber('00') === 0 && app.faceNumber('pip_4') === 4 && app.faceNumber('-1') === -1, 'numbers');
  check(app.faceNumber('skull') === null && app.faceNumber('') === null, 'symbols');
  const [tens, pip, old, unread, symbol, flagged, nul, noType, oldUnread, blankType, oddType, insane] = app.readDice([
    { type: 'D10', value: 0, face: '00', readable: true },
    { type: 'd6', value: 'pip_4' },
    { type: 'd20', value: 15 },
    { type: 'd8', value: -1, face: '-1', readable: false },
    { type: 'd12', value: 'unknown' },
    { type: 'd6', value: 3, face: '3', readable: 'false' },
    null,
    { value: 2 },
    { type: 'd20', value: -1 },
    { type: '', value: 3 },
    { type: 'd7', value: 5 },
    { type: 'd6', value: 2.5, face: '2.5', readable: true }
  ]);
  check(JSON.stringify(tens) === '{"type":"d10","value":0,"face":"00","readable":true}', `tens ${JSON.stringify(tens)}`);
  check(pip.value === 4 && pip.readable && old.value === 15 && old.face === '15' && old.readable, 'pip and old server');
  check(!unread.readable && unread.value === -1 && !symbol.readable && !flagged.readable, 'unreadable, symbol, readable "false"');
  check(!nul.readable && nul.type === 'd?', 'non-object entry');
  check(noType.type === 'd?' && !noType.readable && noType.value === -1 && !blankType.readable, `no type is unreadable ${JSON.stringify(noType)}`);
  check(!oddType.readable && oddType.type === 'd7', 'a type the tray can\'t take is unreadable');
  check(!oldUnread.readable && oldUnread.face === '-1', 'old server\'s -1 is unreadable');
  check(!insane.readable && insane.value === -1, 'readable: true with a non-integer value is unreadable');
  check(app.readDice(undefined).length === 0 && app.readDice({}).length === 0, 'no dice list');
});

await test('display: faces as printed, pips as dots, ? when unread; counts by type', () => {
  check(app.displayFace(vtt('d10', '00')) === '00' && app.displayFace(vtt('d6', 'pip_5')) === '5' && app.displayFace(vtt('d8', '-1', false)) === '?', 'faces');
  check(app.summarizeDice([vtt('d8', '-1', false), vtt('d8', '-1', false), vtt('d20', '-1', false)]) === '2d8, 1d20', 'summary');
  check(app.formatDiceString(app.readDice([vtt('d10', '00'), vtt('d10', '7'), vtt('d6', 'pip_4')])) === '2d10(00, 7) + 1d6(4)', 'chat string');
});

await test('convertToTalespireFormat sends numbers, pips as dots', () => {
  const group = app.convertToTalespireFormat({ dice: app.readDice([vtt('d6', 'pip_3'), vtt('d6', 'pip_6')]), total: 9 });
  check(JSON.stringify(group.result) === '{"kind":"d6","results":[3,6]}', JSON.stringify(group));
});

await test('Roll Once: an unreadable die isn\'t sent, and it keeps waiting for the reroll', () => {
  const { b, log } = bridge({ once: true });
  b.handleRoll({ dice: [vtt('d20', '17'), vtt('d8', '-1', false)], total: 17 });
  check(log.rolls.length === 0 && log.unusable.length === 1, `onRoll ${log.rolls.length}, unusable ${log.unusable.length}`);
  check(log.unusable[0].unreadable.length === 1 && log.unusable[0].unreadable[0].type === 'd8', 'names the d8');
  check(JSON.stringify(log.sent) === '["waiting"]' && b.pendingRollOnce && b.isWaiting, `re-registered ${JSON.stringify(log.sent)}`);
  b.handleRoll({ dice: [vtt('d20', '17'), vtt('d8', '6')], total: 23 });
  check(log.rolls.length === 1 && log.rolls[0].dice[1].value === 6, 'the reroll is sent');
  check(!b.pendingRollOnce && !b.isWaiting && log.sent.length === 1, 'then back to idle');
});

await test('continuous: an unreadable die isn\'t sent and it re-registers', () => {
  const { b, log } = bridge({ continuous: true });
  b.handleRoll({ dice: [vtt('d6', 'unknown', false)], total: 0 });
  check(log.rolls.length === 0 && log.unusable.length === 1 && JSON.stringify(log.sent) === '["waiting"]', JSON.stringify(log));
  check(b.isWaiting && b.continuousMode && log.unusable[0].waiting, 'still waiting, in continuous mode');
});

await test('no dice list, or an empty one: not sent, reported as unusable', () => {
  const { b, log } = bridge({ once: true });
  b.handleRoll({ total: 0 });
  b.handleRoll({ dice: [], total: 0 });
  check(log.rolls.length === 0 && log.unusable.length === 2 && log.unusable[0].unreadable.length === 0, JSON.stringify(log.unusable));
  check(b.pendingRollOnce && b.isWaiting, 'still waiting');
  check(JSON.stringify(log.sent) === '["waiting","waiting"]', `re-registered after each: ${JSON.stringify(log.sent)}`);
});

await test('not waiting: an unreadable roll is reported, nothing sent', () => {
  const { b, log } = bridge();
  b.isWaiting = true; // e.g. a roll already on its way when continuous mode was turned off
  b.handleRoll({ dice: [vtt('d20', '-1', false)], total: 0 });
  check(log.unusable.length === 1 && log.sent.length === 0 && !b.isWaiting, JSON.stringify(log));
  check(log.unusable[0].waiting === false, 'tells the UI it isn\'t waiting');
});

await test('Roll Once while disconnected: an unusable roll reports not waiting', () => {
  const { b, log } = bridge({ once: true });
  b.isConnected = () => false;
  b.handleRoll({ dice: [vtt('d8', '-1', false)], total: 0 });
  check(!b.isWaiting && log.unusable[0].waiting === false && log.sent.length === 0, JSON.stringify(log));
});

await test('re-registers waiting even if onUnusableRoll throws', () => {
  const { b, log } = bridge({ once: true });
  b.onUnusableRoll = () => { throw new Error('UI broke'); };
  try { b.handleRoll({ dice: [vtt('d8', '-1', false)], total: 0 }); } catch { /* the check below is what matters */ }
  check(JSON.stringify(log.sent) === '["waiting"]' && b.isWaiting, JSON.stringify(log.sent));
});

await test('socket messages: roll (new and old format), roll without data, no_dice', () => {
  const { b, log } = bridge({ once: true });
  const recv = msg => b.handleMessage({ data: JSON.stringify(msg) });
  recv({ type: 'no_dice', session_code: 'XKRM4N7B' });
  check(log.sent.length === 0 && b.isWaiting, 'no_dice changes nothing');
  recv({ type: 'roll' });
  check(log.unusable.length === 1 && JSON.stringify(log.sent) === '["waiting"]', `roll without data re-registers ${JSON.stringify(log)}`);
  recv({ type: 'roll', data: { dice: [{ type: 'd20', value: 12 }], total: 12 } });
  check(log.rolls.length === 1 && log.rolls[0].dice[0].face === '12' && !b.pendingRollOnce, 'old-format roll goes through');
  const c = bridge({ continuous: true });
  c.b.handleMessage({ data: JSON.stringify({ type: 'roll', data: { dice: [vtt('d10', '00'), vtt('d6', 'pip_4')], total: 4 } }) });
  check(c.log.rolls.length === 1 && c.log.rolls[0].dice[0].face === '00', 'new-format roll goes through');
});

await test('UI: unusable roll message names the dice and says whether it waits', () => {
  const shown = [];
  const recent = [];
  const ui = { showError: m => shown.push(m), addRecentRoll: (...args) => recent.push(args) };
  const roll = { dice: [vtt('d8', '-1', false)], total: 0 };
  app.UIController.prototype.handleUnusableRoll.call(ui, roll, roll.dice, true);
  app.UIController.prototype.handleUnusableRoll.call(ui, { dice: [] }, [], false);
  check(shown[0] === "Couldn't read 1d8. Roll again; still waiting.", shown[0]);
  check(shown[1] === 'That roll had no dice. Not sent to the dice tray.', shown[1]);
  check(recent.every(([, success, notSent]) => success === false && notSent === true), 'listed as not sent');
});

await test('UI: Recent Rolls escapes server text and marks not-sent and failed rolls', () => {
  check(!app.escapeHtml('<img src=x onerror="y">').includes('<') && !app.escapeHtml('"').includes('"'), 'escapeHtml');
  const ui = { elements: { rollsList: { innerHTML: '' } }, recentRolls: [
    { dice: [{ type: '<b>', value: -1, face: '<i>', readable: false }], total: 0, notSent: true, success: false, displayTime: 't' },
    { dice: [vtt('d20', '15')], total: 15, notSent: false, success: false, displayTime: 't' },
  ] };
  app.UIController.prototype.renderRecentRolls.call(ui);
  const html = ui.elements.rollsList.innerHTML;
  check(!html.includes('<b>') && html.includes('&lt;b&gt;'), 'die type escaped');
  check(html.includes('not-sent') && html.includes('roll-item failed'), html);
});

await test('a readable roll still goes to onRoll with read dice', () => {
  const { b, log } = bridge({ continuous: true });
  b.handleRoll({ dice: [{ type: 'd20', value: 15 }], total: 15, roll_id: 'r1' });
  check(log.rolls.length === 1 && log.rolls[0].dice[0].face === '15' && log.rolls[0].roll_id === 'r1', JSON.stringify(log.rolls));
  check(JSON.stringify(log.sent) === '["waiting"]', 'continuous re-registers');
});

await test('sendToTalespire: tray gets numbers, chat gets faces as printed', async () => {
  const calls = { tray: [], chat: [] };
  context.TS = {
    dice: { sendDiceResult: async groups => { calls.tray.push(groups); return {}; } },
    chat: { send: async (msg, target) => { calls.chat.push([msg, target]); } }
  };
  try {
    const ok = (await app.sendToTalespire({ dice: app.readDice([vtt('d10', '00'), vtt('d10', '4')]), total: 4 }, { rollName: 'Pct' })).sent;
    check(ok && JSON.stringify(calls.tray[0][0].result) === '{"kind":"d10","results":[0,4]}', JSON.stringify(calls.tray));
    check(calls.chat[0]?.[0] === 'Pct: 2d10(00, 4) = 4' && calls.chat[0][1] === 'board', JSON.stringify(calls.chat));
    context.TS.dice.sendDiceResult = async () => ({ error: 'incorrectTypes' });
    let failed = await app.sendToTalespire({ dice: app.readDice([vtt('d20', '3')]), total: 3 });
    check(failed.sent === false && failed.error === 'incorrectTypes', `a tray error counts as failure ${JSON.stringify(failed)}`);
    context.TS.dice.sendDiceResult = async () => { throw new Error('boom'); };
    failed = await app.sendToTalespire({ dice: app.readDice([vtt('d20', '3')]), total: 3 });
    check(failed.sent === false && failed.error === 'boom', `a throw counts as failure ${JSON.stringify(failed)}`);
  } finally {
    delete context.TS;
  }
});

// ---------------------------------------------------------------------------
// TaleSpire API as documented (symbiote-docs.talespire.com, API v0.1)
// ---------------------------------------------------------------------------

/** A TS stand-in: campaign storage holds ONE blob (no keys), calls are recorded. */
function fakeTS({ blob = undefined, visible = true, notificationFails = false, chatFails = false, whisperFails = false, visibilityThrows = false, readFails = 0, writeFails = 0, trayFails = false } = {}) {
  const calls = { setBlob: [], getBlob: [], chat: [], notifications: [], tray: [] };
  let stored = blob;
  let reads = 0;
  let writes = 0;
  context.TS = {
    localStorage: { campaign: {
      getBlob: async (...args) => { calls.getBlob.push(args); if (reads++ < readFails) throw { cause: 'readFailed' }; return stored; },
      setBlob: async (...args) => { calls.setBlob.push(args); await new Promise(r => setTimeout(r, 1)); if (writes++ < writeFails) throw { cause: 'writeFailed' }; stored = args[0]; },
      deleteBlob: async () => { stored = undefined; }
    } },
    chat: { send: async (msg, target) => {
      const whisper = target === 'player-me';
      if ((whisper && whisperFails) || (!whisper && chatFails)) throw { cause: 'invalidTarget' };
      calls.chat.push([msg, target]);
    } },
    dice: { sendDiceResult: async groups => { if (trayFails) throw { cause: 'invalidDiceType' }; calls.tray.push(groups); return 'roll-1'; } },
    symbiote: {
      getIfThisSymbioteIsVisible: async () => { if (visibilityThrows) throw { cause: 'unknown' }; return visible; },
      sendNotification: async (title, body) => { if (notificationFails) throw { cause: 'symbioteManifestMissingInteropId' }; calls.notifications.push([title, body]); }
    },
    players: { whoAmI: async () => ({ id: 'player-me' }) }
  };
  Object.assign(app.campaignStore, { cache: null, loading: null, queue: Promise.resolve(), onSaveFailed: null, lastReadError: null });
  return { calls, stored: () => stored };
}

await test('storage: one JSON blob, no keys; old keyed saves read as nothing saved', async () => {
  check(JSON.stringify(app.parseStoredState('dicevision_options')) === '{}', 'pre-1.1.0 blob (a key name) is ignored');
  check(JSON.stringify(app.parseStoredState('[1]')) === '{}' && JSON.stringify(app.parseStoredState(undefined)) === '{}', 'arrays and nothing');
  check(app.parseStoredState('{"sessionCode":"XKRM4N7B"}').sessionCode === 'XKRM4N7B', 'a saved object');
  const { calls, stored } = fakeTS({ blob: 'dicevision_session_code' });
  check(JSON.stringify(await app.campaignStore.load()) === '{}', 'old blob loads as {}');
  check(calls.getBlob[0].length === 0, `getBlob called without a key ${JSON.stringify(calls.getBlob)}`);
  // A session save and an options save at the same moment both survive
  await Promise.all([
    app.campaignStore.update({ sessionCode: 'XKRM4N7B' }),
    app.campaignStore.update({ options: { rollTarget: 'gm', continuousMode: true } })
  ]);
  check(calls.setBlob.every(args => args.length === 1 && typeof args[0] === 'string'), `setBlob(str) only ${JSON.stringify(calls.setBlob)}`);
  const saved = JSON.parse(stored());
  check(saved.sessionCode === 'XKRM4N7B' && saved.options?.rollTarget === 'gm', `both kept ${stored()}`);
  await app.campaignStore.update({ sessionCode: null });
  check(JSON.parse(stored()).options?.continuousMode === true && JSON.parse(stored()).sessionCode === null, 'clearing the code keeps the options');
  delete context.TS;
});

await test('storage: a failed read isn\'t remembered, and a save never overwrites what it couldn\'t read', async () => {
  const saved = JSON.stringify({ sessionCode: 'XKRM4N7B', options: { rollName: 'Attack' } });
  // Read fails once, then works: the save re-reads and keeps the options
  let ts = fakeTS({ blob: saved, readFails: 1 });
  check(await app.campaignStore.load() === null && app.campaignStore.lastReadError === 'readFailed', 'load reports the failure');
  check(await app.campaignStore.update({ sessionCode: 'ABCD2345' }) === true, 'save after a later good read');
  const after = JSON.parse(ts.stored());
  check(after.sessionCode === 'ABCD2345' && after.options?.rollName === 'Attack', `options kept ${ts.stored()}`);
  // Read keeps failing: nothing is written, and the failure is reported
  ts = fakeTS({ blob: saved, readFails: 99 });
  const failures = [];
  app.campaignStore.onSaveFailed = reason => failures.push(reason);
  check(await app.campaignStore.update({ sessionCode: null }) === false, 'save refused');
  check(ts.stored() === saved && ts.calls.setBlob.length === 0, 'stored settings untouched');
  check(failures.length === 1 && /readFailed/.test(failures[0]), `reported ${JSON.stringify(failures)}`);
  delete context.TS;
});

await test('storage: a failed write is reported, not cached, and later saves still run', async () => {
  const ts = fakeTS({ blob: '{}', writeFails: 1 });
  const failures = [];
  app.campaignStore.onSaveFailed = reason => failures.push(reason);
  check(await app.campaignStore.update({ sessionCode: 'XKRM4N7B' }) === false, 'first save fails');
  check(failures[0] === 'writeFailed' && app.campaignStore.cache.sessionCode === undefined, `not cached as saved ${JSON.stringify(app.campaignStore.cache)}`);
  check(await app.campaignStore.update({ options: { rollName: 'X' } }) === true, 'queue carries on');
  check(JSON.parse(ts.stored()).options?.rollName === 'X', ts.stored());
  delete context.TS;
});

await test('storage: overlapping loads share one read', async () => {
  const ts = fakeTS({ blob: '{"sessionCode":"XKRM4N7B"}' });
  const [a, b] = await Promise.all([app.campaignStore.load(), app.campaignStore.load()]);
  check(a === b && ts.calls.getBlob.length === 1, `reads ${ts.calls.getBlob.length}`);
  delete context.TS;
});

await test('describeError: TaleSpire rejections have a cause, not a message', () => {
  check(app.describeError({ cause: 'notInCampaign' }) === 'notInCampaign' && app.describeError(new Error('boom')) === 'boom' && app.describeError('x') === 'x', 'reasons');
});

await test('chat: GM only uses TaleSpire\'s "gms" keyword', async () => {
  const { calls } = fakeTS();
  await app.sendToTalespire({ dice: app.readDice([vtt('d20', '12')]), total: 12 }, { chatTarget: 'gm' });
  await app.sendToTalespire({ dice: app.readDice([vtt('d20', '12')]), total: 12 }, { chatTarget: 'board' });
  check(calls.chat[0]?.[1] === 'gms' && calls.chat[1]?.[1] === 'board', JSON.stringify(calls.chat));
  delete context.TS;
});

await test('chat: a failed announcement doesn\'t count the roll as failed', async () => {
  const { calls } = fakeTS({ chatFails: true });
  const result = await app.sendToTalespire({ dice: app.readDice([vtt('d20', '12')]), total: 12 }, { chatTarget: 'gm' });
  check(result.sent === true && result.chatError === 'invalidTarget' && calls.tray.length === 1, `result ${JSON.stringify(result)}, tray ${calls.tray.length}`);
  delete context.TS;
});

await test('notifyOutsidePanel: nothing while visible; a notification when hidden; a whisper if that fails', async () => {
  let { calls } = fakeTS({ visible: true });
  check(await app.notifyOutsidePanel('msg') === 'visible' && calls.notifications.length === 0 && calls.chat.length === 0, 'visible');
  ({ calls } = fakeTS({ visible: false }));
  check(await app.notifyOutsidePanel('Couldn\'t read 1d8.') === 'notification' && calls.notifications[0]?.[1] === 'Couldn\'t read 1d8.', JSON.stringify(calls.notifications));
  ({ calls } = fakeTS({ visible: false, notificationFails: true }));
  check(await app.notifyOutsidePanel('Couldn\'t read 1d8.') === 'whisper' && calls.chat[0]?.[1] === 'player-me' && /Couldn't read 1d8/.test(calls.chat[0][0]), JSON.stringify(calls.chat));
  delete context.TS;
  check(await app.notifyOutsidePanel('x') === 'none', 'no TaleSpire API');
});

/** A UIController without the DOM: fake elements, recorded panel messages. */
function fakeUI(options = {}) {
  const ui = Object.create(app.UIController.prototype);
  const el = (props = {}) => ({ value: '', checked: false, style: {}, disabled: false, ...props });
  const errors = [];
  Object.assign(ui, {
    bridge: new app.DiceVisionBridge(),
    recentRolls: [],
    unusableNotified: false,
    showError: msg => errors.push(msg),
    addRecentRoll: () => {},
    elements: {
      rollName: el({ value: 'Physical Dice' }), chatAnnounce: el({ checked: true }), rollTarget: el({ value: 'board' }),
      continuousModeToggle: el(), sessionCodeInput: el(), ...options
    }
  });
  ui.connected = [];
  ui.handleConnect = () => ui.connected.push({ code: ui.elements.sessionCodeInput.value, continuous: ui.bridge.continuousMode });
  return { ui, errors };
}

await test('unusable rolls notify outside the panel once until a roll goes through', async () => {
  const { calls } = fakeTS({ visible: false });
  const { ui } = fakeUI();
  const unread = { dice: app.readDice([vtt('d8', '-1', false)]), total: 0 };
  const [first, second] = await Promise.all([ui.handleUnusableRoll(unread, unread.dice, true), ui.handleUnusableRoll(unread, unread.dice, true)]);
  check(first === 'notification' && second === 'already-notified' && calls.notifications.length === 1, `once ${first} ${second}`);
  check(calls.notifications[0][1] === "Couldn't read 1d8. Roll again; still waiting.", calls.notifications[0][1]);
  await ui.handleRoll({ dice: app.readDice([vtt('d8', '5')]), total: 5 });
  await ui.handleUnusableRoll(unread, unread.dice, true);
  check(calls.notifications.length === 2, `again after a roll went through ${calls.notifications.length}`);
  const empty = await fakeUI().ui.handleUnusableRoll({ dice: [], total: 0 }, [], true);
  check(empty === 'notification' && /no dice/.test(calls.notifications[2]?.[1]), `empty roll message ${JSON.stringify(calls.notifications[2])}`);
  delete context.TS;
});

await test('not waiting: the notice says the roll wasn\'t sent, not "still waiting"', async () => {
  const { calls } = fakeTS({ visible: false });
  const { ui, errors } = fakeUI();
  const unread = { dice: app.readDice([vtt('d8', '-1', false)]), total: 0 };
  await ui.handleUnusableRoll(unread, unread.dice, false);
  check(errors[0] === "Couldn't read 1d8. Not sent to the dice tray." && calls.notifications[0]?.[1] === errors[0], `${JSON.stringify(errors)} ${JSON.stringify(calls.notifications)}`);
  delete context.TS;
});

await test('a notice skipped because the panel was open doesn\'t use up the one notification', async () => {
  const { calls } = fakeTS({ visible: true });
  const { ui } = fakeUI();
  const unread = { dice: app.readDice([vtt('d8', '-1', false)]), total: 0 };
  check(await ui.handleUnusableRoll(unread, unread.dice, true) === 'visible' && !ui.unusableNotified, 'panel open: nothing sent, flag clear');
  context.TS.symbiote.getIfThisSymbioteIsVisible = async () => false; // the player closes the panel
  check(await ui.handleUnusableRoll(unread, unread.dice, true) === 'notification' && calls.notifications.length === 1, 'then notified');
  delete context.TS;
});

await test('notifyOutsidePanel: a failing visibility check still notifies; every channel failing returns none', async () => {
  let { calls } = fakeTS({ visibilityThrows: true });
  check(await app.notifyOutsidePanel('m') === 'notification' && calls.notifications.length === 1, 'visibility throws → notification');
  ({ calls } = fakeTS({ visible: false, notificationFails: true, whisperFails: true }));
  check(await app.notifyOutsidePanel('m') === 'none', 'nothing worked');
  delete context.TS;
});

await test('handleRoll: tray and chat failures are shown with their reason', async () => {
  fakeTS({ trayFails: true });
  let { ui, errors } = fakeUI();
  await ui.handleRoll({ dice: app.readDice([vtt('d20', '12')]), total: 12 });
  check(/dice tray \(invalidDiceType\)/.test(errors[0] ?? ''), `tray ${JSON.stringify(errors)}`);
  fakeTS({ chatFails: true });
  ({ ui, errors } = fakeUI());
  await ui.handleRoll({ dice: app.readDice([vtt('d20', '12')]), total: 12 });
  check(/chat announcement failed \(invalidTarget\)/.test(errors[0] ?? ''), `chat ${JSON.stringify(errors)}`);
  delete context.TS;
});

await test('loadSavedState: options first, then auto-connect with a saved code only', async () => {
  fakeTS({ blob: JSON.stringify({ sessionCode: 'XKRM4N7B', options: { chatAnnounce: false, rollTarget: 'gm', rollName: 'Attack', continuousMode: true } }) });
  let { ui } = fakeUI();
  await ui.loadSavedState();
  const e = ui.elements;
  check(e.chatAnnounce.checked === false && e.rollTarget.value === 'gm' && e.rollName.value === 'Attack' && e.continuousModeToggle.checked === true, 'options applied');
  check(JSON.stringify(ui.connected) === '[{"code":"XKRM4N7B","continuous":true}]', `connected in continuous mode ${JSON.stringify(ui.connected)}`);
  for (const blob of [JSON.stringify({ sessionCode: null }), JSON.stringify({ sessionCode: 42 }), 'dicevision_session_code', undefined]) {
    fakeTS({ blob });
    ({ ui } = fakeUI());
    await ui.loadSavedState();
    check(ui.connected.length === 0, `no auto-connect for ${blob}`);
  }
  delete context.TS;
});

await test('loadSavedState: an unreadable store is shown, not treated as nothing saved', async () => {
  const saved = JSON.stringify({ sessionCode: 'XKRM4N7B' });
  const ts = fakeTS({ blob: saved, readFails: 99 });
  const { ui, errors } = fakeUI();
  await ui.loadSavedState();
  check(ui.connected.length === 0 && /Couldn't read saved DiceVision settings \(readFailed\)/.test(errors[0] ?? ''), JSON.stringify(errors));
  check(ts.stored() === saved, 'stored settings untouched');
  delete context.TS;
});

await test('saveOptions and loadSavedState use the same keys', async () => {
  fakeTS();
  const { ui } = fakeUI({ chatAnnounce: { checked: false, style: {} }, rollTarget: { value: 'gm', style: {} }, rollName: { value: 'Damage', style: {} }, continuousModeToggle: { checked: true, style: {} } });
  await ui.saveOptions();
  app.campaignStore.cache = null; // a fresh symbiote reads storage again
  const fresh = fakeUI().ui;
  await fresh.loadSavedState();
  const e = fresh.elements;
  check(e.chatAnnounce.checked === false && e.rollTarget.value === 'gm' && e.rollName.value === 'Damage' && e.continuousModeToggle.checked === true, 'round trip');
  delete context.TS;
});

await test('an invalid saved code is cleared, keeping the options', async () => {
  const ts = fakeTS({ blob: JSON.stringify({ sessionCode: 'ABC', options: { rollName: 'Attack' } }) });
  const b = new app.DiceVisionBridge();
  b.connect('ABC');
  await app.campaignStore.queue;
  const saved = JSON.parse(ts.stored());
  check(saved.sessionCode === null && saved.options?.rollName === 'Attack', ts.stored());
  delete context.TS;
});

await test('manifest: documented fields, local paths exist, interop id set', () => {
  const root = new URL('../symbiote/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  for (const path of [manifest.entryPoint, manifest.descriptionFilePath, manifest.icons?.['64x64']]) {
    check(typeof path === 'string' && path.startsWith('/') && existsSync(new URL(path.slice(1), root)), `local path ${path}`);
  }
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(manifest.api?.interop?.id ?? ''), 'interop id is a UUIDv4 (notifications need it)');
  check(manifest.api?.version === '0.1' && manifest.environment?.extras?.includes('colorStyles'), 'API and theme');
  for (const field of ['author', 'description', 'type', 'interactivity']) check(!(field in manifest), `no undocumented ${field}`);
});

await test('CSS: only documented colorStyles variables', () => {
  const documented = ['--ts-color-primary', '--ts-color-secondary', '--ts-background-primary', '--ts-background-secondary', '--ts-background-tertiary', '--ts-accessibility-border', '--ts-accessibility-focus', '--ts-color-danger', '--ts-accent-primary', '--ts-accent-hover', '--ts-accent-background', '--ts-button-background', '--ts-button-hover', '--ts-link', '--ts-link-hover'];
  const css = readFileSync(new URL('../symbiote/app.css', import.meta.url), 'utf8');
  const used = [...new Set(css.match(/--ts-[a-z-]+/g) ?? [])];
  check(used.every(v => documented.includes(v)), `undocumented: ${used.filter(v => !documented.includes(v))}`);
  check(!/accessibility-border/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), '--ts-accessibility-border is transparent in the default theme; not used for borders');
});

// ---------------------------------------------------------------------------
// Values a die can't show (the tray took a d4 of 12 from a misread)
// ---------------------------------------------------------------------------

await test('inRangeForDie: each die\'s faces; d10 0-10 and percentile tens', () => {
  const ok = [['d4', 1], ['d4', 4], ['d6', 6], ['d8', 8], ['d12', 12], ['d20', 20], ['d10', 0], ['d10', 10], ['d10', 30], ['d10', 90], ['d100', 100], ['d100', 0]];
  const bad = [['d4', 12], ['d4', 0], ['d6', 0], ['d6', 7], ['d8', 9], ['d12', 13], ['d20', 21], ['d10', 35], ['d10', 100], ['d100', 101]];
  check(ok.every(([t, v]) => app.inRangeForDie(t, v)), `in range ${JSON.stringify(ok.filter(([t, v]) => !app.inRangeForDie(t, v)))}`);
  check(bad.every(([t, v]) => !app.inRangeForDie(t, v)), `out of range ${JSON.stringify(bad.filter(([t, v]) => app.inRangeForDie(t, v)))}`);
});

await test('readDice marks an impossible value outOfRange, unreadable, and keeps its face', () => {
  const [d4, d20, pct] = app.readDice([vtt('d4', '12'), vtt('d20', '20'), vtt('d10', '30')]);
  check(!d4.readable && d4.outOfRange === true && d4.value === -1 && d4.face === '12', JSON.stringify(d4));
  check(d20.readable && !('outOfRange' in d20) && pct.readable, 'in-range dice untouched');
  check(app.displayFace(d4) === '12' && app.displayFace(app.readDice([vtt('d8', '-1', false)])[0]) === '?', 'shown as read, not "?"');
  check(JSON.stringify(app.readDice([d4])) === JSON.stringify([d4]), `the same when read again ${JSON.stringify(app.readDice([d4]))}`);
});

await test('Roll Once: an impossible die isn\'t sent; the panel says what was read', async () => {
  const { b, log } = bridge({ once: true });
  b.handleRoll({ dice: [vtt('d20', '14'), vtt('d4', '12')], total: 26 });
  check(log.rolls.length === 0 && log.unusable.length === 1 && b.pendingRollOnce && JSON.stringify(log.sent) === '["waiting"]', JSON.stringify(log));
  fakeTS({ visible: true });
  const { ui, errors } = fakeUI();
  await ui.handleUnusableRoll(log.unusable[0].roll, log.unusable[0].unreadable, true);
  check(errors[0] === 'Read as impossible: d4 showing 12. Roll again; still waiting.', errors[0]);
  const mixed = app.readDice([vtt('d8', '-1', false), vtt('d4', '12'), vtt('d6', '9')]);
  await ui.handleUnusableRoll({ dice: mixed, total: 0 }, mixed, false);
  check(errors[1] === "Couldn't read 1d8. Read as impossible: d4 showing 12, d6 showing 9. Not sent to the dice tray.", errors[1]);
  delete context.TS;
});

console.log(`\n${passes} checks passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
