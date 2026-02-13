---
id: ur-0d4e
status: todo
deps: []
links: []
created: 2026-02-13T08:09:31Z
type: task
priority: 2
tags: [research]
---
# Research: Undo/Redo Approaches Comparison — Command Pattern, Memento Pattern, Operational Transformation

## Goal
Document and compare three approaches to implementing undo/redo in a text editor: Command Pattern, Memento Pattern, and Operational Transformation (OT).

---

## 1. Command Pattern

### Overview
Each edit operation is encapsulated as a command object with `execute()` and `undo()` methods. Commands are pushed onto an undo stack; undoing pops from the undo stack and pushes onto a redo stack.

### TypeScript Pseudocode

```typescript
interface Command {
  execute(): void;
  undo(): void;
}

class InsertCommand implements Command {
  constructor(
    private doc: TextDocument,
    private position: number,
    private text: string
  ) {}

  execute(): void {
    this.doc.insert(this.position, this.text);
  }

  undo(): void {
    this.doc.delete(this.position, this.text.length);
  }
}

class DeleteCommand implements Command {
  private deletedText: string = "";

  constructor(
    private doc: TextDocument,
    private position: number,
    private length: number
  ) {}

  execute(): void {
    this.deletedText = this.doc.getText(this.position, this.length);
    this.doc.delete(this.position, this.length);
  }

  undo(): void {
    this.doc.insert(this.position, this.deletedText);
  }
}

class UndoManager {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  executeCommand(cmd: Command): void {
    cmd.execute();
    this.undoStack.push(cmd);
    this.redoStack = []; // clear redo on new action
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (cmd) {
      cmd.undo();
      this.redoStack.push(cmd);
    }
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (cmd) {
      cmd.execute();
      this.undoStack.push(cmd);
    }
  }
}
```

### Complexity Analysis
- **Time**: O(1) for undo/redo (single command execution). Command execution itself depends on the underlying data structure (e.g., O(n) for array-based insert in middle of document, O(log n) for rope/piece-table).
- **Space**: O(k) where k = number of commands stored. Each command stores minimal data (position + text for deletes). For insert-only commands, no extra text storage needed. For deletes, stores the deleted text — in the worst case O(n) per delete command where n is the deleted text length. Total space across all commands: O(Σ|deleted_text_i|).

### Collaborative Editing Pros/Cons
**Pros:**
- Simple to implement and reason about for single-user scenarios
- Commands can be serialized and sent over the network
- Composable: commands can be grouped into macro/compound commands

**Cons:**
- Undo is **local-only** by default — undoing command C1 when another user has since applied C2 that depends on C1's result causes conflicts
- No built-in conflict resolution; positions shift when remote edits arrive, invalidating stored positions
- Requires additional transformation layer to work in collaborative settings (essentially re-inventing OT)

---

## 2. Memento Pattern

### Overview
The entire document state (or a diff/snapshot) is captured before each edit. Undo restores the previous snapshot. Simple but memory-heavy for large documents.

### TypeScript Pseudocode

```typescript
interface Memento {
  readonly content: string;
  readonly cursorPosition: number;
  readonly selectionRange: [number, number] | null;
}

class TextDocument {
  private content: string = "";
  private cursorPosition: number = 0;
  private selectionRange: [number, number] | null = null;

  createMemento(): Memento {
    return {
      content: this.content,
      cursorPosition: this.cursorPosition,
      selectionRange: this.selectionRange ? [...this.selectionRange] : null,
    };
  }

  restoreMemento(m: Memento): void {
    this.content = m.content;
    this.cursorPosition = m.cursorPosition;
    this.selectionRange = m.selectionRange;
  }

  insert(pos: number, text: string): void {
    this.content = this.content.slice(0, pos) + text + this.content.slice(pos);
    this.cursorPosition = pos + text.length;
  }

  delete(pos: number, length: number): void {
    this.content = this.content.slice(0, pos) + this.content.slice(pos + length);
    this.cursorPosition = pos;
  }
}

class MementoUndoManager {
  private undoStack: Memento[] = [];
  private redoStack: Memento[] = [];

  saveState(doc: TextDocument): void {
    this.undoStack.push(doc.createMemento());
    this.redoStack = [];
  }

  undo(doc: TextDocument): void {
    const memento = this.undoStack.pop();
    if (memento) {
      this.redoStack.push(doc.createMemento());
      doc.restoreMemento(memento);
    }
  }

  redo(doc: TextDocument): void {
    const memento = this.redoStack.pop();
    if (memento) {
      this.undoStack.push(doc.createMemento());
      doc.restoreMemento(memento);
    }
  }
}

// Usage:
// const mgr = new MementoUndoManager();
// mgr.saveState(doc);  // before each edit
// doc.insert(5, "hello");
// mgr.undo(doc);       // restores previous state
```

### Complexity Analysis
- **Time**: O(n) for undo/redo where n = document size (full state copy on save and restore). Can be optimized with copy-on-write or incremental diffs to amortize.
- **Space**: O(k × n) where k = number of snapshots, n = average document size. This is the **major drawback**. Mitigation strategies:
  - Store diffs instead of full snapshots: reduces to O(k × d) where d = average diff size
  - Periodic full snapshots + diffs (checkpoint strategy)
  - Limit undo depth

### Collaborative Editing Pros/Cons
**Pros:**
- Conceptually simple — each state is self-contained
- No risk of inverse-operation bugs (you restore the exact prior state)
- Easy to implement "undo to any point in history" (jump to any snapshot)

**Cons:**
- **Fundamentally incompatible with collaborative editing** — restoring a full snapshot overwrites other users' concurrent changes
- Diffs help but still don't resolve conflicts from concurrent edits
- High bandwidth cost if snapshots need to be synced
- Cannot do selective undo (undo only your own operations) without additional machinery

---

## 3. Operational Transformation (OT)

### Overview
Each edit is represented as an operation. A `transform` function adjusts operations against concurrent operations so they can be applied in any order and converge to the same state. This is the foundation of Google Docs-style collaboration. Undo is implemented by computing the inverse of an operation and transforming it against all subsequent operations.

### TypeScript Pseudocode

```typescript
type Op =
  | { type: "insert"; pos: number; text: string }
  | { type: "delete"; pos: number; text: string };

function inverse(op: Op): Op {
  switch (op.type) {
    case "insert": return { type: "delete", pos: op.pos, text: op.text };
    case "delete": return { type: "insert", pos: op.pos, text: op.text };
  }
}

// Transform op1 against op2 (both originated from same state).
// Returns op1' such that apply(apply(state, op2), op1') == apply(apply(state, op1), op2')
function transform(op1: Op, op2: Op): Op {
  if (op1.type === "insert" && op2.type === "insert") {
    if (op1.pos <= op2.pos) return { ...op1 };
    return { ...op1, pos: op1.pos + op2.text.length };
  }
  if (op1.type === "insert" && op2.type === "delete") {
    if (op1.pos <= op2.pos) return { ...op1 };
    if (op1.pos >= op2.pos + op2.text.length)
      return { ...op1, pos: op1.pos - op2.text.length };
    return { ...op1, pos: op2.pos }; // insert falls within deleted range
  }
  if (op1.type === "delete" && op2.type === "insert") {
    if (op1.pos >= op2.pos)
      return { ...op1, pos: op1.pos + op2.text.length };
    if (op1.pos + op1.text.length <= op2.pos) return { ...op1 };
    // delete range spans the insert point — split (simplified: adjust length)
    return { ...op1, text: op1.text.slice(0, op2.pos - op1.pos) + op1.text.slice(op2.pos - op1.pos) };
  }
  // delete vs delete — handle overlap
  if (op1.pos >= op2.pos + op2.text.length)
    return { ...op1, pos: op1.pos - op2.text.length };
  if (op1.pos + op1.text.length <= op2.pos) return { ...op1 };
  // overlapping deletes: remove the non-overlapping part only
  const start = Math.max(op1.pos, op2.pos + op2.text.length);
  const end = Math.max(op1.pos + op1.text.length, op2.pos + op2.text.length);
  if (start >= end) return { type: "delete", pos: op2.pos, text: "" }; // fully overlapped, noop
  return { type: "delete", pos: Math.min(op1.pos, op2.pos), text: op1.text.slice(start - op1.pos, end - op1.pos) };
}

class OTUndoManager {
  private localOps: Op[] = [];       // ops this client performed
  private remoteOps: Op[] = [];      // ops received from server since last local op

  recordLocal(op: Op): void {
    this.localOps.push(op);
  }

  recordRemote(op: Op): void {
    this.remoteOps.push(op);
  }

  undo(): Op | null {
    const op = this.localOps.pop();
    if (!op) return null;
    let inv = inverse(op);
    // Transform inverse against all subsequent remote ops
    for (const remote of this.remoteOps) {
      inv = transform(inv, remote);
    }
    return inv; // apply this to document
  }
}
```

### Complexity Analysis
- **Time**: O(1) for applying a single operation. Undo is O(r) where r = number of remote operations since the undone operation (must transform against each). Transform of two operations is O(1) for simple char-level ops.
- **Space**: O(h) where h = total history length (all operations stored). Each operation is small — O(|text|) per op. More compact than memento but grows unboundedly without garbage collection/compaction.

### Collaborative Editing Pros/Cons
**Pros:**
- **Designed for collaboration** — transform guarantees convergence across all clients
- Supports selective undo (undo only your operations, not others')
- Efficient over the network (send small ops, not full state)
- Battle-tested (Google Docs, Apache Wave)

**Cons:**
- **Complex to implement correctly** — transform functions must satisfy convergence properties (TP1, TP2) which are notoriously hard to prove
- Edge cases in overlapping delete/delete and delete/insert interactions
- Server typically required as central authority for ordering
- Debugging is difficult — subtle convergence bugs may only appear under specific interleaving
- Modern alternative: CRDTs (e.g., Yjs, Automerge) avoid the need for a central server and have simpler correctness proofs, but with different trade-offs (tombstone overhead, larger metadata)

---

## Summary Comparison

| Aspect | Command Pattern | Memento Pattern | Operational Transformation |
|---|---|---|---|
| **Implementation complexity** | Low | Very Low | High |
| **Undo time** | O(1) | O(n) doc size | O(r) remote ops |
| **Space** | O(k × d_avg) | O(k × n) | O(h × d_avg) |
| **Selective undo** | Difficult | Not possible | Native support |
| **Collaborative support** | Requires OT/CRDT layer | Incompatible | Native |
| **State consistency** | Local only | Local only | Convergent (distributed) |
| **Best for** | Single-user editors | Simple/small docs, prototypes | Multi-user real-time editors |

### Recommendation
- **Single-user text editor**: Command Pattern — best balance of simplicity and efficiency.
- **Simple app with small documents**: Memento with diff optimization — easiest to get right.
- **Collaborative editor**: OT (or consider CRDTs as a modern alternative) — the only approach that natively handles concurrent edits and selective undo.
