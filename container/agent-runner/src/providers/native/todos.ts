const MAX_TODOS = 8;
const MAX_CONTENT_LENGTH = 160;
const TODO_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export type NativeTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface NativeTodo {
  id: string;
  content: string;
  status: NativeTodoStatus;
}

export interface NativeTodoSnapshot {
  todos: NativeTodo[];
  summary: { pending: number; inProgress: number; completed: number };
}

function normalizedTodo(value: NativeTodo): NativeTodo {
  const id = String(value.id ?? '').trim();
  const content = String(value.content ?? '').replace(/\s+/g, ' ').trim();
  const status = value.status;
  if (!TODO_ID.test(id)) throw new Error(`Invalid todo id: ${id || '(empty)'}`);
  if (!content || content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Todo ${id} content must be 1-${MAX_CONTENT_LENGTH} characters`);
  }
  if (!['pending', 'in_progress', 'completed'].includes(status)) {
    throw new Error(`Invalid status for todo ${id}: ${String(status)}`);
  }
  return { id, content, status };
}

export class NativeTodoState {
  private todos: NativeTodo[] = [];

  snapshot(): NativeTodoSnapshot {
    const todos = this.todos.map((todo) => ({ ...todo }));
    return {
      todos,
      summary: {
        pending: todos.filter((todo) => todo.status === 'pending').length,
        inProgress: todos.filter((todo) => todo.status === 'in_progress').length,
        completed: todos.filter((todo) => todo.status === 'completed').length,
      },
    };
  }

  update(values: NativeTodo[]): NativeTodoSnapshot {
    if (!Array.isArray(values) || values.length === 0) throw new Error('todos must contain at least one item');
    if (values.length > MAX_TODOS) throw new Error(`todos cannot contain more than ${MAX_TODOS} items`);
    const next = values.map(normalizedTodo);
    if (new Set(next.map((todo) => todo.id)).size !== next.length) throw new Error('Todo ids must be unique');

    const incomplete = next.filter((todo) => todo.status !== 'completed');
    const active = next.filter((todo) => todo.status === 'in_progress');
    if (active.length > 1 || (incomplete.length > 0 && active.length !== 1)) {
      throw new Error('Exactly one todo must be in_progress while work remains');
    }

    const nextById = new Map(next.map((todo) => [todo.id, todo]));
    for (const previous of this.todos) {
      const replacement = nextById.get(previous.id);
      if (!replacement) throw new Error(`Existing todo cannot be removed during a turn: ${previous.id}`);
      if (replacement.content !== previous.content) throw new Error(`Existing todo content cannot change: ${previous.id}`);
      if (previous.status === 'completed' && replacement.status !== 'completed') {
        throw new Error(`Completed todo cannot be reopened: ${previous.id}`);
      }
    }

    this.todos = next;
    return this.snapshot();
  }
}

export function shouldRequireTodos(prompt: string): boolean {
  if (/\b(?:do not|don't)\s+(?:call|use)\s+(?:any\s+)?tools?\b/i.test(prompt)) return false;
  if (/\b(?:three|four|five|six|seven|eight|[3-8])\s+(?:distinct\s+)?steps?\b/i.test(prompt)) return true;
  const listedSteps = [...prompt.matchAll(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+\S/g)].length;
  if (listedSteps >= 3) return true;
  const sequenceWords = ['first', 'second', 'third', 'finally'].filter((word) =>
    new RegExp(`\\b${word}\\b`, 'i').test(prompt),
  );
  return sequenceWords.length >= 3;
}

export const NATIVE_TODO_INSTRUCTIONS = [
  '## In-turn todos',
  '',
  'For work with three or more distinct steps, call `todo_update` before implementation.',
  'Keep 3-8 concise items, exactly one `in_progress` while work remains, and update',
  'the list as steps finish. Before answering, complete every item or explain blockers.',
  'Skip todos for simple answers or one-step actions. Todos are ephemeral to this turn;',
  'use task tools instead for durable or scheduled work.',
].join('\n');