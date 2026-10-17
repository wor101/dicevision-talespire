// Unit tests for symbiote/app.js, run with `node tests/app.test.mjs`.
// app.js is a browser script, so it's loaded into a vm context with just
// enough stand-ins (no Talespire, no DOM).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../symbiote/app.js', import.meta.url), 'utf8');
const context = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {} }, window: {}, setTimeout, clearTimeout, setInterval, clearInterval });
const app = vm.runInContext(`${source}
;({ DiceVisionBridge, UIController, readDice, faceNumber, displayFace, summarizeDice, formatDiceString, convertToTalespireFormat, sendToTalespire, parseStoredState, campaignStore, notifyOutsidePanel })`, context);

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
  b.onUnusableRoll = (roll, unreadable) => log.unusable.push({ roll, unreadable });
  b.continuousMode = continuous;
  b.pendingRollOnce = once;
  b.isWaiting = continuous || once;
  return { b, log };
}

await test('faceNumber and readDice read every server shape', () => {
  check(app.faceNumber('00') === 0 && app.faceNumber('pip_4') === 4 && app.faceNumber('-1') === -1, 'numbers');
  check(app.faceNumber('skull') === null && app.faceNumber('') === null, 'symbols');
  const [tens, pip, old, unread, symbol, flagged, nul, noType] = app.readDice([
    { type: 'D10', value: 0, face: '00', readable: true },
    { type: 'd6', value: 'pip_4' },
    { type: 'd20', value: 15 },
    { type: 'd8', value: -1, face: '-1', readable: false },
    { type: 'd12', value: 'unknown' },
    { type: 'd6', value: 3, face: '3', readable: 'false' },
    null,
    { value: 2 }
  ]);
  check(JSON.stringify(tens) === '{"type":"d10","value":0,"face":"00","readable":true}', `tens ${JSON.stringify(tens)}`);
  check(pip.value === 4 && pip.readable && old.value === 15 && old.face === '15' && old.readable, 'pip and old server');
  check(!unread.readable && unread.value === -1 && !symbol.readable && !flagged.readable, 'unreadable, symbol, readable "false"');
  check(!nul.readable && nul.type === 'd?' && noType.type === 'd?', 'malformed entries');
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
});

await test('no dice list, or an empty one: not sent, reported as unusable', () => {
  const { b, log } = bridge({ once: true });
  b.handleRoll({ total: 0 });
  b.handleRoll({ dice: [], total: 0 });
  check(log.rolls.length === 0 && log.unusable.length === 2 && log.unusable[0].unreadable.length === 0, JSON.stringify(log.unusable));
  check(b.pendingRollOnce, 'still waiting');
});

await test('not waiting: an unreadable roll is reported, nothing sent', () => {
  const { b, log } = bridge();
  b.handleRoll({ dice: [vtt('d20', '-1', false)], total: 0 });
  check(log.unusable.length === 1 && log.sent.length === 0 && !b.isWaiting, JSON.stringify(log));
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
    const ok = await app.sendToTalespire({ dice: app.readDice([vtt('d10', '00'), vtt('d10', '4')]), total: 4 }, { rollName: 'Pct' });
    check(ok && JSON.stringify(calls.tray[0][0].result) === '{"kind":"d10","results":[0,4]}', JSON.stringify(calls.tray));
    check(calls.chat[0]?.[0] === 'Pct: 2d10(00, 4) = 4' && calls.chat[0][1] === 'board', JSON.stringify(calls.chat));
  } finally {
    delete context.TS;
  }
});

// ---------------------------------------------------------------------------
// TaleSpire API as documented (symbiote-docs.talespire.com, API v0.1)
// ---------------------------------------------------------------------------

/** A TS stand-in: campaign storage holds ONE blob (no keys), calls are recorded. */
function fakeTS({ blob = undefined, visible = true, notificationFails = false, chatFails = false } = {}) {
  const calls = { setBlob: [], getBlob: [], chat: [], notifications: [], tray: [] };
  let stored = blob;
  context.TS = {
    localStorage: { campaign: {
      getBlob: async (...args) => { calls.getBlob.push(args); return stored; },
      setBlob: async (...args) => { calls.setBlob.push(args); await new Promise(r => setTimeout(r, 1)); stored = args[0]; },
      deleteBlob: async () => { stored = undefined; }
    } },
    chat: { send: async (msg, target) => { if (chatFails) throw { cause: 'invalidTarget' }; calls.chat.push([msg, target]); } },
    dice: { sendDiceResult: async groups => { calls.tray.push(groups); return 'roll-1'; } },
    symbiote: {
      getIfThisSymbioteIsVisible: async () => visible,
      sendNotification: async (title, body) => { if (notificationFails) throw { cause: 'symbioteManifestMissingInteropId' }; calls.notifications.push([title, body]); }
    },
    players: { whoAmI: async () => ({ id: 'player-me' }) }
  };
  app.campaignStore.cache = null;
  app.campaignStore.queue = Promise.resolve();
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

await test('storage: a failing getBlob (e.g. notInCampaign) loads as nothing saved', async () => {
  fakeTS();
  context.TS.localStorage.campaign.getBlob = async () => { throw { cause: 'notInCampaign' }; };
  check(JSON.stringify(await app.campaignStore.load()) === '{}', 'empty state');
  delete context.TS;
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
  const ok = await app.sendToTalespire({ dice: app.readDice([vtt('d20', '12')]), total: 12 }, { chatTarget: 'gm' });
  check(ok === true && calls.tray.length === 1, `ok ${ok}, tray ${calls.tray.length}`);
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

await test('unusable rolls notify outside the panel once until a roll goes through', async () => {
  const { calls } = fakeTS({ visible: false });
  const ui = Object.create(app.UIController.prototype);
  Object.assign(ui, { showError: () => {}, addRecentRoll: () => {}, unusableNotified: false,
    elements: { rollName: { value: 'Physical Dice' }, chatAnnounce: { checked: false }, rollTarget: { value: 'board' } } });
  const unread = { dice: app.readDice([vtt('d8', '-1', false)]), total: 0 };
  ui.handleUnusableRoll(unread, unread.dice);
  ui.handleUnusableRoll(unread, unread.dice);
  await new Promise(r => setTimeout(r, 5));
  check(calls.notifications.length === 1, `once ${calls.notifications.length}`);
  await ui.handleRoll({ dice: app.readDice([vtt('d8', '5')]), total: 5 });
  ui.handleUnusableRoll(unread, unread.dice);
  await new Promise(r => setTimeout(r, 5));
  check(calls.notifications.length === 2, `again after a roll went through ${calls.notifications.length}`);
  delete context.TS;
});

console.log(`\n${passes} checks passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
