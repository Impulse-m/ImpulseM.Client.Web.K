import type {MyDocument} from '@appManagers/appDocsManager';
import type {MyPhoto} from '@appManagers/appPhotosManager';
import {THUMB_TYPE_FULL} from '@appManagers/constants';
import type {PhotoSize} from '@layer';

export default function getMediaViewerCacheType(
  media: MyPhoto | MyDocument,
  layoutSize: PhotoSize | undefined
): string {
  // Layout may choose a thumbnail, but documents are downloaded into the full-file slot.
  return media._ === 'document' ? THUMB_TYPE_FULL : layoutSize?.type;
}
