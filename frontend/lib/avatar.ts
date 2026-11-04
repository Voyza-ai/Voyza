/**
 * Avatars are stored inline on user_profiles.avatar_url as a small JPEG
 * data: URL, so no storage bucket is needed. The image is centre-cropped to
 * a square and scaled to AVATAR_SIZE px in the browser — typically 5-15 KB.
 */
export const AVATAR_SIZE = 160;
export const AVATAR_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function resizeImageToDataUrl(file: File, size = AVATAR_SIZE): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    throw new Error('Choose a PNG, JPEG, WebP or GIF image.');
  }
  if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
    throw new Error('That image is over 10 MB — choose a smaller one.');
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That file could not be read as an image.'));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser could not process the image.');
    ctx.fillStyle = '#ffffff'; // transparent PNGs → white, not black, as JPEG
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
