import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnqueueUnavailableError, MODAL_APP, MODAL_FUNCTION, modalEnqueuer } from './enqueue';

const spawn = vi.fn();
const fromName = vi.fn();
vi.mock('modal', () => ({
  ModalClient: class {
    functions = { fromName };
  },
}));

describe('modalEnqueuer', () => {
  beforeEach(() => {
    spawn.mockReset().mockResolvedValue({});
    fromName.mockReset().mockResolvedValue({ spawn });
  });

  it('spawns process_room with positional args', async () => {
    await modalEnqueuer.enqueue({ jobId: 'j', roomId: 'r', videoPath: 'v' });
    expect(fromName).toHaveBeenCalledWith(MODAL_APP, MODAL_FUNCTION);
    expect(spawn).toHaveBeenCalledWith(['j', 'r', 'v']);
  });

  it('reports a missing deployment as unavailable', async () => {
    fromName.mockRejectedValue(new Error('not found'));
    await expect(
      modalEnqueuer.enqueue({ jobId: 'j', roomId: 'r', videoPath: 'v' }),
    ).rejects.toBeInstanceOf(EnqueueUnavailableError);
  });
});
