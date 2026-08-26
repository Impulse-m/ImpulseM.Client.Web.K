import getFileMimeType from '@helpers/files/getFileMimeType';
import gifToVideo, {canConvertGifToVideo} from '@helpers/gifToVideo';

// `photos.uploadProfilePhoto` has mutually-exclusive `file` (static) and `video`
// (animated MPEG4) arms — there is no gif arm (.demo/telegram-docs-text/bots/api.md:7210
// documents InputProfilePhotoAnimated as "an animated profile photo in the MPEG4
// format"). A picked gif is therefore transcoded to mp4 with the same converter
// outgoing message gifs use (`@helpers/gifToVideo`), so it takes the video arm of
// the avatar editor exactly like a picked mp4 would. When the browser can't
// convert (`canConvertGifToVideo()` false), the gif is returned unchanged and
// falls through to the existing static-image path (first frame only) rather
// than failing outright.
//
// Only applies when `isEditingForAvatar` is set — non-avatar callers of
// `getFileAndOpenEditor` (e.g. the poll/quiz media attachment picker) are
// unaffected.
export default async function resolveAvatarPickedFile(file: File, isEditingForAvatar: boolean | undefined): Promise<File> {
  if(!isEditingForAvatar || getFileMimeType(file) !== 'image/gif' || !(await canConvertGifToVideo())) {
    return file;
  }

  const {blob} = await gifToVideo(file);
  return new File([blob], file.name.replace(/\.[^.]+$/, '.mp4'), {type: 'video/mp4'});
}
