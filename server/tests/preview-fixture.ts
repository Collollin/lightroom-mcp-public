import jpeg from 'jpeg-js';

const encoded = jpeg.encode({ width: 32, height: 16, data: Buffer.alloc(32 * 16 * 4, 127) }, 70).data;
export function previewFixture(photo_id: string | number = 914, requested_size = 512) {
  return { photo_id, requested_size, width: 32, height: 16, bytes: encoded.length,
    image: { mime_type: 'image/jpeg', data: encoded.toString('base64') } };
}
