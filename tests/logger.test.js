import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';

function capture() {
  const lines = [];
  return { sink: (line) => lines.push(line), lines };
}

test('info, warn and error always print', () => {
  const { sink, lines } = capture();
  const log = createLogger({ verbose: false, sink });
  log.info('checked 10');
  log.warn('slow');
  log.error('broken');
  assert.deepEqual(lines, ['checked 10', 'WARN: slow', 'ERROR: broken']);
});

test('detail is suppressed when not verbose', () => {
  const { sink, lines } = capture();
  const log = createLogger({ verbose: false, sink });
  log.detail('com.secret.app is live');
  assert.deepEqual(lines, []);
});

test('detail prints when verbose', () => {
  const { sink, lines } = capture();
  const log = createLogger({ verbose: true, sink });
  log.detail('com.secret.app is live');
  assert.deepEqual(lines, ['com.secret.app is live']);
});
