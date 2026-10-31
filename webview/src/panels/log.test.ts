import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../store';
import { logMatches } from './LogPanel';

const e: LogEntry = { seq: 1, ts: 0, kind: 'call', node: 'app.core.master.Master.submit', caller: 'app.routers.jobs.submit_job', depth: 1, text: 'job=JobCreate(kind=square)' };

describe('log filter', () => {
  it('words, exclusions and node:', () => {
    expect(logMatches(e, 'square')).toBe(true);
    expect(logMatches(e, 'square !submit_job')).toBe(false);
    expect(logMatches(e, 'node:master')).toBe(true);
    expect(logMatches(e, 'node:submit_job')).toBe(false);
  });
});
