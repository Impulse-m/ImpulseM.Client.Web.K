import createSerializedQueue from '@helpers/createSerializedQueue';

/** Every call start, switch and recovery runs through this FIFO, one at a time. */
export class CallTransitionCoordinator {
  private transitionQueue = createSerializedQueue();

  public run<T>(callback: () => Promise<T>): Promise<T> {
    return this.transitionQueue.enqueue(callback);
  }
}

const callTransitionCoordinator = new CallTransitionCoordinator();
export default callTransitionCoordinator;
