// The seal net's state machine, frame by frame, with no session around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSealNet } from '../src/sealnet.js';

const init = { type: 'system', subtype: 'init' };
const started = (id, extra = {}) => ({ type: 'system', subtype: 'task_started', task_id: id, is_backgrounded: true, ...extra });
const done = (id) => ({ type: 'system', subtype: 'task_notification', task_id: id });
const res = (subtype = 'success') => ({ type: 'result', subtype });

/** Drives a net with a tasks map the way `runClaude` does (agents only here). */
function harness() {
  const net = createSealNet();
  const tasks = new Map();
  return {
    net, tasks,
    feed(m) {
      if (m.subtype === 'task_started') tasks.set(m.task_id, true);
      if (m.subtype === 'task_notification') tasks.delete(m.task_id);
      net.observe(m, tasks);
    },
    result(m, mine = false) { return net.result(m, tasks, { mine }); },
  };
}

test('a subagent out at the seal is debt; the turn after its report adopts and closes the window', () => {
  const h = harness();
  h.feed(init);
  h.feed(started('a'));
  assert.deepEqual(h.result(res(), true).seal, { out: 1, early: 0 });
  h.feed(done('a'));
  assert.equal(h.net.awaitsTurn(), true, 'reported, and no turn has opened');
  h.feed(init);
  assert.equal(h.net.awaitsTurn(), false);
  assert.equal(h.result(res()).adopt, true);
  h.feed(init);
  assert.equal(h.result(res()).adopt, false, 'the window is closed: a turn of the CLI on its own is not the answer');
});

test('a background subagent that reported inside the sealed turn is debt too; a foreground one is not', () => {
  const bg = harness();
  bg.feed(init); bg.feed(started('a')); bg.feed(done('a'));
  assert.deepEqual(bg.result(res(), true).seal, { out: 0, early: 1 });
  assert.equal(bg.net.awaitsTurn(), true);

  const fg = harness();
  fg.feed(init); fg.feed(started('a', { is_backgrounded: false })); fg.feed(done('a'));
  assert.deepEqual(fg.result(res(), true).seal, { out: 0, early: 0 });
  assert.equal(fg.net.awaitsTurn(), false);
  fg.feed(init);
  assert.equal(fg.result(res()).adopt, false, 'no debt, no window');

  const unknown = harness();
  unknown.feed(init); unknown.feed(started('a', { is_backgrounded: undefined })); unknown.feed(done('a'));
  assert.equal(unknown.result(res(), true).seal.early, 0, 'a frame without the field counts as foreground');
});

test('reports from a turn before the last result are not early for the next seal', () => {
  const h = harness();
  h.feed(init); h.feed(started('a')); h.feed(done('a'));
  h.result(res(), false);   // a result that does not answer our prompt
  h.feed(init);
  assert.equal(h.result(res(), true).seal.early, 0);
});

test('a turn already in flight when the last report arrived does not close the window', () => {
  const h = harness();
  h.feed(init); h.feed(started('a'));
  h.result(res(), true);
  h.feed(init); h.feed(done('a'));
  assert.equal(h.result(res()).adopt, true);
  assert.equal(h.net.awaitsTurn(), true, 'the turn that follows the report is still to come');
  h.feed(init);
  assert.equal(h.result(res()).adopt, true, 'the window is still open');
  h.feed(init);
  assert.equal(h.result(res()).adopt, false);
});

test('an error result closes the window but is never adopted', () => {
  const h = harness();
  h.feed(init); h.feed(started('a'));
  h.result(res(), true);
  h.feed(done('a')); h.feed(init);
  assert.equal(h.result(res('error_max_turns')).adopt, false);
  h.feed(init);
  assert.equal(h.result(res()).adopt, false);
});

test('a CLI that sends no init: a result opens the next turn right after the previous one', () => {
  const h = harness();
  h.feed(started('a'));
  h.result(res(), true);
  h.feed(done('a'));
  assert.equal(h.result(res()).adopt, true);
  assert.equal(h.result(res()).adopt, false, 'closed by the first result after the report');
});

const assistant = (parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [] } });

test('a CLI with no init: the first main-thread assistant frame opens the turn, so a report inside it does not close', () => {
  const h = harness();
  h.feed(started('a'));
  h.result(res(), true);
  h.feed(done('a'));
  assert.equal(h.net.turnOpen(), false);
  h.feed(assistant());
  assert.equal(h.net.turnOpen(), true, 'the turn is open and the channel must stay up for it');
  h.feed(started('b'));
  h.feed(done('b'));
  const first = h.result(res());
  assert.equal(first.adopt, true);
  assert.equal(first.closes, false, 'B reported inside that turn: it is not the turn that follows the report');
  h.feed(assistant());
  assert.equal(h.result(res()).closes, true);
});

test('an assistant frame of a subagent (parent_tool_use_id set) does not open the main turn', () => {
  const h = harness();
  h.feed(started('a'));
  h.result(res(), true);
  h.feed(done('a'));
  h.feed(assistant('toolu_1'));
  assert.equal(h.net.turnOpen(), false);
});

test('giving up on the awaited turn ends the window', () => {
  const h = harness();
  h.feed(init); h.feed(started('a')); h.feed(done('a'));
  h.result(res(), true);
  h.net.giveUp();
  assert.equal(h.net.awaitsTurn(), false);
  h.feed(init);
  assert.equal(h.result(res()).adopt, false);
});

// ---- #31 §1: a subagent launched after the seal is owed too

test('#31 §1: a subagent launched after the seal keeps the window open past the turn that says «waiting for B»', () => {
  const h = harness();
  h.feed(init); h.feed(started('a'));
  h.result(res(), true);
  h.feed(done('a')); h.feed(init);            // A reported; the CLI opens the turn that reads it
  h.feed(started('b'));                       // that turn launches B
  const waiting = h.result(res());
  assert.deepEqual(waiting, { adopt: true, closes: false }, 'B is out: this is not the last turn');
  h.feed(done('b'));
  assert.equal(h.net.awaitsTurn(), true, 'B reported and the turn that reads it has not opened');
  h.feed(init);
  assert.deepEqual(h.result(res()), { adopt: true, closes: true });
  h.feed(init);
  assert.equal(h.result(res()).adopt, false, 'closed');
});

test('#31 §1: a background subagent launched after the seal that reports inside its own turn does not let that turn close', () => {
  const h = harness();
  h.feed(init); h.feed(started('a'));
  h.result(res(), true);
  h.feed(done('a')); h.feed(init);
  h.feed(started('b')); h.feed(done('b'));
  assert.equal(h.result(res()).closes, false);
  assert.equal(h.net.awaitsTurn(), true);
});

test('#31 §1: a foreground subagent launched and finished inside a later turn owes nothing', () => {
  const h = harness();
  h.feed(init); h.feed(started('a'));
  h.result(res(), true);
  h.feed(done('a')); h.feed(init);
  h.feed(started('b', { is_backgrounded: false })); h.feed(done('b'));
  assert.deepEqual(h.result(res()), { adopt: true, closes: true });
});

// ---- one test per mutant the reviews of #28 ran against the net

test('mutant «drop the early count»: a background report inside the sealed turn is debt', () => {
  const h = harness();
  h.feed(init); h.feed(started('a')); h.feed(done('a'));
  const v = h.result(res(), true);
  assert.equal(v.seal.early, 1);
  assert.equal(h.net.awaitsTurn(), true, 'the turn that reads the report is still to come');
  h.feed(init);
  assert.equal(h.result(res()).adopt, true, 'and it is adopted');
});

test('mutant «never close the window»: the turn after the last report ends it', () => {
  const h = harness();
  h.feed(init); h.feed(started('a'));
  h.result(res(), true);
  h.feed(done('a')); h.feed(init);
  assert.equal(h.result(res()).closes, true);
  h.feed(init);
  assert.equal(h.result(res()).adopt, false);
});

test('mutant «restore the old adoption condition»: a result inside the window is adopted only on success', () => {
  const h = harness();
  h.feed(init); h.feed(started('a'));
  h.result(res(), true);
  h.feed(done('a')); h.feed(init);
  const v = h.result(res('error_during_execution'));
  assert.equal(v.adopt, false, 'an error is never the answer');
  assert.equal(v.closes, true, 'but it still ends the window');
});

test('mutant «close the window without a clean turn»: a turn in flight at the report does not close', () => {
  const h = harness();
  h.feed(init); h.feed(started('a'));
  h.result(res(), true);
  h.feed(init); h.feed(done('a'));
  assert.equal(h.result(res()).closes, false);
});

test('mutant «ignore is_backgrounded»: a foreground report inside the sealed turn is no debt', () => {
  const h = harness();
  h.feed(init); h.feed(started('a', { is_backgrounded: false })); h.feed(done('a'));
  assert.equal(h.result(res(), true).seal.early, 0);
  assert.equal(h.net.awaitsTurn(), false);
});

test('mutant «remove the held-open wait»: after the report the net asks for the channel until the turn opens', () => {
  const h = harness();
  h.feed(init); h.feed(started('a'));
  h.result(res(), true);
  assert.equal(h.net.awaitsTurn(), false, 'still out: nothing to wait for yet');
  h.feed(done('a'));
  assert.equal(h.net.awaitsTurn(), true);
});

test('before the seal every result is the answer, and nothing is debt without a subagent', () => {
  const h = harness();
  assert.equal(h.result(res(), false).adopt, true);
  assert.deepEqual(h.result(res(), true).seal, { out: 0, early: 0 });
  h.feed(init);
  assert.equal(h.result(res()).adopt, false);
});
