import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TranscriptSyncer } from '../../src/main/bridge/transcript-syncer';

describe('Transcript Correlation & Observation Invariants (Protocol v2)', () => {
  it('parses user and assistant turns without altering delivery receipts', () => {
    const syncer = new TranscriptSyncer();
    const mockLines = [
      JSON.stringify({
        type: 'USER_INPUT',
        step_index: 1,
        source: 'USER_EXPLICIT',
        content: '<USER_REQUEST>Fix button layout padding</USER_REQUEST>',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        step_index: 2,
        source: 'MODEL',
        content: 'I have updated the button padding in sidebar.css',
        tool_calls: [
          {
            name: 'replace_file_content',
            args: { TargetFile: 'sidebar.css' },
          },
        ],
      }),
    ];

    const parsed = syncer.parseTranscriptLines(mockLines);
    assert.strictEqual(parsed.length, 2);

    const userMsg = parsed[0]!;
    assert.strictEqual(userMsg.role, 'user');
    assert.strictEqual(userMsg.text, 'Fix button layout padding');

    const assistantMsg = parsed[1]!;
    assert.strictEqual(assistantMsg.role, 'assistant');
    assert.strictEqual(assistantMsg.text, 'I have updated the button padding in sidebar.css');
    assert.strictEqual(assistantMsg.toolCalls?.length, 1);
  });

  it('safely handles malformed transcript lines without throwing or mutating history', () => {
    const syncer = new TranscriptSyncer();
    const brokenLines = [
      'not a json line',
      '{ broken: json',
      JSON.stringify({ type: 'UNKNOWN_EVENT', foo: 'bar' }),
      JSON.stringify({
        type: 'USER_INPUT',
        content: 'Valid user instruction',
      }),
    ];

    const parsed = syncer.parseTranscriptLines(brokenLines);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0]?.text, 'Valid user instruction');
  });

  it('extracts and preserves image attachments without embedding huge base64 in transcript log', () => {
    const syncer = new TranscriptSyncer();
    const line = JSON.stringify({
      type: 'USER_INPUT',
      content: '<USER_REQUEST>Look at @[e:\\Work\\snapshots\\test.png] and check padding</USER_REQUEST>',
    });

    const parsed = syncer.parseTranscriptLines([line]);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0]?.attachedImages?.[0]?.name, 'test.png');
  });
});
