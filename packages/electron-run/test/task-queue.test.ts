import { describe, expect, it } from 'vitest';
import { createTaskQueue } from '../src/task-queue.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createTaskQueue', () => {
  it('runs tasks serially in order', async () => {
    const enqueue = createTaskQueue();
    const order: number[] = [];

    const first = enqueue(async () => {
      await tick();
      order.push(1);
    });
    const second = enqueue(async () => {
      order.push(2);
    });

    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("returns each task's own result", async () => {
    const enqueue = createTaskQueue();
    await expect(enqueue(() => 42)).resolves.toBe(42);
    await expect(enqueue(async () => 'later')).resolves.toBe('later');
  });

  it('keeps running after a task rejects', async () => {
    const enqueue = createTaskQueue();
    const order: string[] = [];

    const failing = enqueue(async () => {
      throw new Error('boom');
    });
    const next = enqueue(async () => {
      order.push('ran after failure');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(order).toEqual(['ran after failure']);
  });
});
