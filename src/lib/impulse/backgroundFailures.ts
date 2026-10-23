import {getLogger} from '@lib/impulseLogger';

const logger = getLogger('impulse-background');

export function reportDifferenceFailure(channelId: ChatId | undefined, error: unknown): void {
  logger.error('Difference request failed', {channelId}, error);
}

export function reportSignOutFailure(error: unknown): void {
  logger.error('Sign-out failed', undefined, error);
}
