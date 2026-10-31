import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import settleUnlessAborted from '@helpers/schedulers/settleUnlessAborted';
import {apiErrorOf} from '@lib/impulse/fleet/fleetError';

export default function pauseUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return settleUnlessAborted<void>(
    signal,
    apiErrorOf('CANCELED', errorCodes.cancelled, signal?.reason),
    (resolve: (value: void) => void): void => {
      timer = setTimeout(resolve, ms);
    },
    (): void => {
      clearTimeout(timer);
    }
  );
}
