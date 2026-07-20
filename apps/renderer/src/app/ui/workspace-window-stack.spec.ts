import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceWindowStack } from './workspace-window-stack';

describe('WorkspaceWindowStack', () => {
  let stack: WorkspaceWindowStack;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    stack = TestBed.inject(WorkspaceWindowStack);
  });

  it('preserves the preview as the initial foreground window', () => {
    expect(stack.active()).toBe('preview');
    expect(stack.zIndex('preview')).toBeGreaterThan(stack.zIndex('editor'));
  });

  it('brings the most recently activated window to the foreground', () => {
    stack.activate('editor');

    expect(stack.active()).toBe('editor');
    expect(stack.zIndex('editor')).toBeGreaterThan(stack.zIndex('preview'));

    stack.activate('preview');

    expect(stack.active()).toBe('preview');
    expect(stack.zIndex('preview')).toBeGreaterThan(stack.zIndex('editor'));
  });
});
