import { describe, test, expect } from 'bun:test';
import { parseTicketShow, getNewNotes, type TicketNote, type ParsedTicket } from '../../extensions/teams/tickets';

describe('parseTicketShow', () => {
  test('parses ticket with notes', () => {
    const raw = `---
id: p-abc1
status: in_progress
deps: []
links: []
created: 2026-02-12T07:02:23Z
type: task
priority: 2
assignee: alice
tags: [team]
---
# Do the thing

Some description

## Notes

**2026-02-12T20:00:00Z**

started working

**2026-02-12T20:05:00Z**

halfway done`;

    const result = parseTicketShow(raw);
    
    expect(result.id).toBe('p-abc1');
    expect(result.status).toBe('in_progress');
    expect(result.assignee).toBe('alice');
    expect(result.subject).toBe('Do the thing');
    expect(result.description).toBe('Some description');
    expect(result.tags).toEqual(['team']);
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0]).toEqual({
      timestamp: '2026-02-12T20:00:00Z',
      text: 'started working'
    });
    expect(result.notes[1]).toEqual({
      timestamp: '2026-02-12T20:05:00Z',
      text: 'halfway done'
    });
  });

  test('parses ticket without notes', () => {
    const raw = `---
id: p-def2
status: pending
deps: []
links: []
created: 2026-02-12T08:00:00Z
type: bug
priority: 1
tags: [urgent, backend]
---
# Fix critical bug

This needs to be addressed immediately.
The system is failing in production.`;

    const result = parseTicketShow(raw);
    
    expect(result.id).toBe('p-def2');
    expect(result.status).toBe('pending');
    expect(result.assignee).toBeUndefined();
    expect(result.subject).toBe('Fix critical bug');
    expect(result.description).toBe('This needs to be addressed immediately.\nThe system is failing in production.');
    expect(result.tags).toEqual(['urgent', 'backend']);
    expect(result.notes).toHaveLength(0);
  });

  test('handles empty tags array', () => {
    const raw = `---
id: p-ghi3
status: completed
deps: []
links: []
created: 2026-02-12T09:00:00Z
type: feature
priority: 3
assignee: bob
tags: []
---
# Simple task

Basic implementation.`;

    const result = parseTicketShow(raw);
    
    expect(result.id).toBe('p-ghi3');
    expect(result.tags).toEqual([]);
    expect(result.assignee).toBe('bob');
  });

  test('handles ticket with multiline note content', () => {
    const raw = `---
id: p-jkl4
status: in_progress
deps: []
links: []
created: 2026-02-12T10:00:00Z
type: task
priority: 2
assignee: charlie
tags: [research]
---
# Research task

Need to investigate options.

## Notes

**2026-02-12T10:30:00Z**

Started investigating three approaches:
1. Option A - simple but limited
2. Option B - complex but flexible
3. Option C - hybrid approach

Need to prototype each one.

**2026-02-12T11:00:00Z**

Option A prototype complete.
Works well for basic cases.`;

    const result = parseTicketShow(raw);
    
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0].text).toBe(`Started investigating three approaches:
1. Option A - simple but limited
2. Option B - complex but flexible
3. Option C - hybrid approach

Need to prototype each one.`);
    expect(result.notes[1].text).toBe(`Option A prototype complete.
Works well for basic cases.`);
  });

  test('throws error for invalid format', () => {
    const invalidRaw = `# Just a heading

No front matter here.`;

    expect(() => parseTicketShow(invalidRaw)).toThrow('Invalid ticket format: missing YAML front matter');
  });
});

describe('getNewNotes', () => {
  const sampleNotes: TicketNote[] = [
    { timestamp: '2026-02-12T10:00:00Z', text: 'First note' },
    { timestamp: '2026-02-12T11:00:00Z', text: 'Second note' },
    { timestamp: '2026-02-12T12:00:00Z', text: 'Third note' },
    { timestamp: '2026-02-12T13:00:00Z', text: 'Fourth note' }
  ];

  test('returns all notes when lastSeenCount is 0', () => {
    const newNotes = getNewNotes(sampleNotes, 0);
    expect(newNotes).toEqual(sampleNotes);
  });

  test('returns new notes since lastSeenCount', () => {
    const newNotes = getNewNotes(sampleNotes, 2);
    expect(newNotes).toHaveLength(2);
    expect(newNotes).toEqual([
      { timestamp: '2026-02-12T12:00:00Z', text: 'Third note' },
      { timestamp: '2026-02-12T13:00:00Z', text: 'Fourth note' }
    ]);
  });

  test('returns empty array when all notes seen', () => {
    const newNotes = getNewNotes(sampleNotes, 4);
    expect(newNotes).toEqual([]);
  });

  test('handles lastSeenCount greater than notes length', () => {
    const newNotes = getNewNotes(sampleNotes, 10);
    expect(newNotes).toEqual([]);
  });

  test('works with empty notes array', () => {
    const newNotes = getNewNotes([], 0);
    expect(newNotes).toEqual([]);
  });
});
