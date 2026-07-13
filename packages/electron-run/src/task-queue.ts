/**
 * A serial task queue: each task runs only after the previous one settles,
 * regardless of whether it resolved or rejected. Callers still observe the
 * result (or rejection) of their own task via the returned promise.
 */
export function createTaskQueue() {
  let tail = Promise.resolve();

  return function enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const operation = tail.then(task, task);
    tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  };
}

export type TaskQueue = ReturnType<typeof createTaskQueue>;
