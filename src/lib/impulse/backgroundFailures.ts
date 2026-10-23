import {getLogger} from '@lib/impulseLogger';

const logger = getLogger('impulse-background');

/** A difference request has no caller to return to when it runs in the background, so its failure is recorded. */
export function reportDifferenceFailure(channelId: ChatId | undefined, error: unknown): void {
  logger.error('Difference request failed', {channelId}, error);
}

/** A sign-out run in the background has no caller to return to, so its failure is recorded. */
export function reportSignOutFailure(error: unknown): void {
  logger.error('Sign-out failed', undefined, error);
}
