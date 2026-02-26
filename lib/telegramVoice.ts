import { getTelegramFilePath, downloadTelegramFile } from './telegram';
import { uploadVoiceToS3 } from './s3';
import { transcribeAudio } from './sarvamStt';

type TelegramVoice = {
  file_id: string;
  file_unique_id?: string;
  mime_type?: string;
};

/**
 * Downloads a Telegram voice message, uploads to S3, transcribes with Sarvam STT,
 * and returns the message text to store (transcript + audio link or fallback).
 */
export async function processVoiceMessage(voice: TelegramVoice): Promise<string> {
  const filePath = await getTelegramFilePath(voice.file_id);
  if (!filePath) return '[Voice message – getFile failed]';

  const audioBuffer = await downloadTelegramFile(filePath);
  if (!audioBuffer) return '[Voice message – download failed]';

  const mimeType = voice.mime_type ?? 'audio/ogg';
  const ext = mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3' : 'ogg';
  const s3Url = await uploadVoiceToS3(
    audioBuffer,
    voice.file_unique_id ?? voice.file_id,
    mimeType,
    ext
  );

  const transcript = await transcribeAudio(
    audioBuffer,
    mimeType,
    `voice.${ext}`
  );

  if (s3Url) {
    if (transcript) {
      console.log('Voice message transcribed and stored at', s3Url);
      return `${transcript}\nAudio: ${s3Url}`;
    }
    console.log('Voice message stored at', s3Url, '(STT failed or returned empty)');
    return `[Transcription unavailable]\nAudio: ${s3Url}`;
  }

  return transcript
    ? `${transcript}\n[Audio: S3 upload failed]`
    : '[Voice message – S3 upload failed]';
}
