import type { TodoItem } from '@/types';

export function createDefaultTodoItems(): TodoItem[] {
  return [
    {
      id: 'take-bins-out',
      text: 'Take bins out',
      done: false,
    },
  ];
}
