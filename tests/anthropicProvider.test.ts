import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { interpretResponse } from '../src/ai/anthropicProvider.js';
import { ProviderError } from '../src/ai/provider.js';

/**
 * Exercises the response-handling half of the Anthropic provider against the
 * exact shapes the API can return. No client, no key, no network.
 */
function message(overrides: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 } as Anthropic.Usage,
    content: [],
    ...overrides,
  } as Anthropic.Message;
}

const toolUseBlock = (input: unknown) =>
  ({ type: 'tool_use', id: 'tu_1', name: 'record_analysis', input }) as Anthropic.ToolUseBlock;

const COMPLETE = {
  sentiment: 'negative',
  feature_requests: [{ title: 'Scheduled exports', confidence: 0.7 }],
  actionable_insight: 'Add scheduling to the export flow.',
};

describe('interpretResponse', () => {
  it('returns the tool input serialised as the raw payload', () => {
    const result = interpretResponse(
      message({ content: [toolUseBlock(COMPLETE)] }),
      'claude-opus-5',
    );

    expect(result.model).toBe('claude-opus-5');
    expect(JSON.parse(result.raw)).toEqual(COMPLETE);
  });

  it('rejects a response truncated by max_tokens rather than using its partial input', () => {
    // The realistic shape: the tool block exists, but generation stopped before
    // the model finished writing its input. Previously this sailed through and
    // either stored an incomplete analysis or produced a "schema validation"
    // error that pointed at the wrong cause entirely.
    const truncated = {
      sentiment: 'negative',
      feature_requests: [{ title: 'Scheduled exp', confidence: 0.7 }],
      // actionable_insight never written
    };

    expect(() =>
      interpretResponse(
        message({ stop_reason: 'max_tokens', content: [toolUseBlock(truncated)] }),
        'claude-opus-5',
        2048,
      ),
    ).toThrow(ProviderError);

    try {
      interpretResponse(
        message({ stop_reason: 'max_tokens', content: [toolUseBlock(truncated)] }),
        'claude-opus-5',
        2048,
      );
    } catch (error) {
      const e = error as ProviderError;
      expect(e.kind).toBe('truncated');
      expect(e.retryable).toBe(false); // same request would truncate again
      // The message names the real cause and the actual fix.
      expect(e.message).toContain('2048');
      expect(e.message).toContain('ANTHROPIC_MAX_TOKENS');
      // The partial payload is still carried through for the audit trail.
      expect(e.raw).toContain('Scheduled exp');
    }
  });

  it('distinguishes truncation from a malformed shape', () => {
    // Both end up FAILED, but an operator needs to know which: one is fixed by
    // raising a limit, the other by changing the prompt or schema.
    const kinds = [
      interpretKind(message({ stop_reason: 'max_tokens', content: [toolUseBlock({})] })),
      interpretKind(message({ stop_reason: 'end_turn', content: [] })),
    ];
    expect(kinds).toEqual(['truncated', 'malformed_output']);
  });

  it('rejects a response with no tool call at all', () => {
    expect(() =>
      interpretResponse(
        message({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Sure! Here is the analysis:', citations: null }] as Anthropic.ContentBlock[],
        }),
        'claude-opus-5',
      ),
    ).toThrow(/did not call record_analysis/);
  });

  it('ignores a tool_use block for some other tool', () => {
    expect(() =>
      interpretResponse(
        message({
          content: [{ type: 'tool_use', id: 'x', name: 'something_else', input: {} }] as Anthropic.ContentBlock[],
        }),
        'claude-opus-5',
      ),
    ).toThrow(/did not call record_analysis/);
  });
});

function interpretKind(msg: Anthropic.Message): string {
  try {
    interpretResponse(msg, 'm');
    return 'ok';
  } catch (error) {
    return (error as ProviderError).kind;
  }
}
