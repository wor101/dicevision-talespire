// Unit tests for symbiote/app.js, run with `node tests/app.test.mjs`.
// app.js is a browser script, so it's loaded into a vm context with just
// enough stand-ins (no Talespire, no DOM).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../symbiote/app.js', import.meta.url), 'utf8');
const context = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {} }, window: {}, setTimeout, clearTimeout, setInterval, clearInterval });
const app = vm.runInContext(`${source}
;({ DiceVisionBridge, UIController, readDice, escapeHtml, faceNumber, displayFace, summarizeDice, formatDiceString, convertToTalespireFormat, sendToTalespire })`, context);

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
  try { b.handleRoll({ dice: [vtt('d8', '-1', false)], total: 0 }); } catch {}
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
    const ok = await app.sendToTalespire({ dice: app.readDice([vtt('d10', '00'), vtt('d10', '4')]), total: 4 }, { rollName: 'Pct' });
    check(ok && JSON.stringify(calls.tray[0][0].result) === '{"kind":"d10","results":[0,4]}', JSON.stringify(calls.tray));
    check(calls.chat[0]?.[0] === 'Pct: 2d10(00, 4) = 4' && calls.chat[0][1] === 'board', JSON.stringify(calls.chat));
    context.TS.dice.sendDiceResult = async () => ({ error: 'incorrectTypes' });
    check(await app.sendToTalespire({ dice: app.readDice([vtt('d20', '3')]), total: 3 }) === false, 'a tray error counts as failure');
    context.TS.dice.sendDiceResult = async () => { throw new Error('boom'); };
    check(await app.sendToTalespire({ dice: app.readDice([vtt('d20', '3')]), total: 3 }) === false, 'a throw counts as failure');
  } finally {
    delete context.TS;
  }
});

console.log(`\n${passes} checks passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
