import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_PATH: ':memory:' } as NodeJS.ProcessEnv;
const env = (extra: Record<string, string>) => ({ ...base, ...extra }) as NodeJS.ProcessEnv;

describe('provider resolution', () => {
  it('falls back to the fake provider when no key is present', () => {
    expect(loadConfig(base).resolvedProvider).toBe('fake');
  });

  it('prefers Gemini in auto mode, since its key is the one reviewers can get free', () => {
    expect(loadConfig(env({ GEMINI_API_KEY: 'g' })).resolvedProvider).toBe('gemini');
    expect(loadConfig(env({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' })).resolvedProvider).toBe(
      'gemini',
    );
  });

  it('uses Anthropic in auto mode when only that key is present', () => {
    expect(loadConfig(env({ ANTHROPIC_API_KEY: 'a' })).resolvedProvider).toBe('anthropic');
  });

  it.each([
    ['gemini', 'GEMINI_API_KEY'],
    ['anthropic', 'ANTHROPIC_API_KEY'],
  ])(
    'refuses to boot when AI_PROVIDER=%s is demanded without its key',
    (provider, keyName) => {
      // The important property: asking for a real model and silently getting a
      // simulated one would be the worst outcome, so this is a startup failure
      // rather than a quiet downgrade.
      expect(() => loadConfig(env({ AI_PROVIDER: provider }))).toThrow(
        new RegExp(`requires ${keyName}`),
      );
    },
  );

  it.each([
    ['gemini', { GEMINI_API_KEY: 'g' }],
    ['anthropic', { ANTHROPIC_API_KEY: 'a' }],
  ])('honours an explicit AI_PROVIDER=%s over what else is available', (provider, keys) => {
    const cfg = loadConfig(env({ ...keys, AI_PROVIDER: provider, GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }));
    expect(cfg.resolvedProvider).toBe(provider);
  });

  it('honours AI_PROVIDER=fake even when real keys are available', () => {
    expect(
      loadConfig(env({ AI_PROVIDER: 'fake', GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }))
        .resolvedProvider,
    ).toBe('fake');
  });

  it('treats a blank key as absent rather than crashing', () => {
    // A .env copied from .env.example has GEMINI_API_KEY= , which arrives as an
    // empty string. This used to fail validation and kill the process on the
    // very first run, before the user had done anything wrong.
    expect(loadConfig(env({ GEMINI_API_KEY: '' })).resolvedProvider).toBe('fake');
    expect(loadConfig(env({ GEMINI_API_KEY: '   ' })).resolvedProvider).toBe('fake');
    expect(loadConfig(env({ ANTHROPIC_API_KEY: '' })).resolvedProvider).toBe('fake');
  });

  it('falls back to defaults when an optional text value is blank', () => {
    const cfg = loadConfig(env({ GEMINI_MODEL: '', DATABASE_PATH: '' }));
    expect(cfg.GEMINI_MODEL).toBe('gemini-3-flash-preview');
    expect(cfg.DATABASE_PATH).toBe('./data/feedback.db');
  });

  it('still resolves a real provider when a blank key sits beside a real one', () => {
    expect(loadConfig(env({ GEMINI_API_KEY: '', ANTHROPIC_API_KEY: 'a' })).resolvedProvider).toBe(
      'anthropic',
    );
  });

  it('rejects an unknown provider name', () => {
    expect(() => loadConfig(env({ AI_PROVIDER: 'chatgpt' }))).toThrow(/Invalid environment/);
  });
});
