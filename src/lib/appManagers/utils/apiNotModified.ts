export type ApiNotModified = {
  _: 'apiNotModified',
  error: ApiError
};

export function isNotModifiedError(error: unknown): boolean {
  return typeof((error as ApiError)?.type) === 'string' &&
    (error as ApiError).type.endsWith('_NOT_MODIFIED');
}

export function makeApiNotModified(error: ApiError): ApiNotModified {
  return {_: 'apiNotModified', error};
}

export function isApiNotModified(value: unknown): value is ApiNotModified {
  return (value as ApiNotModified)?._ === 'apiNotModified';
}

export function absorbApiNotModified<T>(promise: Promise<T>): Promise<T | ApiNotModified> {
  return promise.catch((error: unknown) => {
    if(isNotModifiedError(error)) {
      return makeApiNotModified(error as ApiError);
    }

    throw error;
  });
}
