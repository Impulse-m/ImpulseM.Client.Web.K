export function apiErrorOf(type: ErrorType, numericCode: number, originalError: unknown, description?: string): ApiError {
  const error: ApiError = {type, code: numericCode, originalError};
  if(description) {
    error.message = description;
  }

  return error;
}
