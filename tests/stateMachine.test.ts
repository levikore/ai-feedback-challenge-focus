import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { FeedbackRepository } from '../src/repositories/feedbackRepository.js';

function repo() {
  return new FeedbackRepository(openDatabase(':memory:'));
}

describe('guarded state transitions', () => {
  it('performs a legal transition exactly once', () => {
    const r = repo();
    const row = r.create('hello');

    expect(r.transition(row.id, 'RECEIVED', 'ANALYZING')).toBe(true);
    expect(r.findById(row.id)!.status).toBe('ANALYZING');
  });

  it('refuses a transition whose `from` no longer matches — this is the race guard', () => {
    const r = repo();
    const row = r.create('hello');

    // First claim wins.
    expect(r.transition(row.id, 'RECEIVED', 'ANALYZING')).toBe(true);
    // A second worker issuing the identical claim matches zero rows.
    expect(r.transition(row.id, 'RECEIVED', 'ANALYZING')).toBe(false);
    // Exactly one worker believes it owns the item.
    expect(r.findById(row.id)!.status).toBe('ANALYZING');
  });

  it('throws on a transition that is not in the state graph at all', () => {
    const r = repo();
    const row = r.create('hello');

    // DONE is terminal — nothing leaves it. A caller attempting this has a
    // logic bug, so it fails loudly rather than returning false.
    expect(() => r.transition(row.id, 'DONE', 'ANALYZING')).toThrow(/Illegal state transition/);
  });

  it('counts attempts only when asked to', () => {
    const r = repo();
    const row = r.create('hello');

    r.transition(row.id, 'RECEIVED', 'ANALYZING', { incrementAttempts: true });
    expect(r.findById(row.id)!.attempts).toBe(1);

    r.transition(row.id, 'ANALYZING', 'FAILED', { lastError: 'boom' });
    expect(r.findById(row.id)!.attempts).toBe(1);
    expect(r.findById(row.id)!.last_error).toBe('boom');
  });

  it('recovers rows stranded in ANALYZING by a dead process', () => {
    const r = repo();
    const row = r.create('hello');
    r.transition(row.id, 'RECEIVED', 'ANALYZING', { incrementAttempts: true });

    // Simulates the next boot.
    expect(r.recoverStranded()).toEqual([row.id]);
    expect(r.findById(row.id)!.status).toBe('RECEIVED');
    expect(r.findPendingIds()).toContain(row.id);
  });
});
