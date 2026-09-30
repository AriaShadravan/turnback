import { expect, it } from 'vitest';
import { exitStatus } from '../src/core/run.js';

it('turns how a command ended into a shell-style exit status', () => {
  expect(exitStatus({ status: 3, signal: null })).toBe(3);
  expect(exitStatus({ status: null, signal: 'SIGTERM' })).toBe(143);
  expect(exitStatus({ status: null, signal: 'SIGINT' })).toBe(130);
  expect(exitStatus({ status: null, signal: 'SIGHUP' })).toBe(129);
  expect(exitStatus({ status: null, signal: null, error: new Error('spawn failed') })).toBe(127);
});
