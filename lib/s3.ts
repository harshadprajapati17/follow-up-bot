import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const region = process.env.AWS_REGION;
const bucket = process.env.AWS_S3_BUCKET;
const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL?.replace(/\/$/, ''); // no trailing slash

function getClient(): S3Client | null {
  if (!region || !bucket || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return null;
  }
  return new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Uploads a buffer to S3 and returns the public URL.
 * Key will be: voice/YYYY-MM-DD/<fileUniqueId>.<ext>
 */
export async function uploadVoiceToS3(
  buffer: Buffer,
  fileUniqueId: string,
  mimeType: string = 'audio/ogg',
  extension: string = 'ogg'
): Promise<string | null> {
  const client = getClient();
  if (!client || !publicBaseUrl) {
    console.error('[s3] Missing AWS_REGION, AWS_S3_BUCKET, S3_PUBLIC_BASE_URL or credentials');
    return null;
  }

  const datePrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `voice/${datePrefix}/${fileUniqueId}.${extension}`;

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      })
    );
    const url = `${publicBaseUrl}/${key}`;
    console.log('[s3] Uploaded voice to', url);
    return url;
  } catch (err) {
    console.error('[s3] Upload failed:', err);
    return null;
  }
}
