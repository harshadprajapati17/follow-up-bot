const TELEGRAM_API_URL = 'https://api.telegram.org/bot';

/**
 * Sends a message to a Telegram chat using the Bot API.
 */
export async function sendTelegramMessage(
  chatId: number,
  text: string
): Promise<void> {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    console.error('TELEGRAM_TOKEN is not set in environment variables');
    return;
  }

  const url = `${TELEGRAM_API_URL}${token}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Failed to send Telegram message:', errorData);
    }
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

/**
 * Sends a voice message to a Telegram chat (sendVoice).
 * @param chatId - Telegram chat ID
 * @param audioBuffer - Audio file bytes (e.g. MP3 or OGG)
 * @param mimeType - e.g. audio/mpeg or audio/ogg
 */
export async function sendTelegramVoice(
  chatId: number,
  audioBuffer: Buffer,
  mimeType: string = 'audio/mpeg'
): Promise<void> {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    console.error('TELEGRAM_TOKEN is not set');
    return;
  }

  const ext = mimeType.includes('ogg') ? 'ogg' : 'mp3';
  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
  formData.append('voice', blob, `voice.${ext}`);

  const url = `${TELEGRAM_API_URL}${token}/sendVoice`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Failed to send Telegram voice:', errorData);
    }
  } catch (error) {
    console.error('Error sending Telegram voice:', error);
  }
}

/**
 * Gets the file path for a Telegram file_id (e.g. voice message).
 * Returns the path to download from or null.
 */
export async function getTelegramFilePath(
  fileId: string
): Promise<string | null> {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return null;
  const url = `${TELEGRAM_API_URL}${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok || !data.result?.file_path) return null;
    return data.result.file_path;
  } catch (e) {
    console.error('[telegram] getFile error:', e);
    return null;
  }
}

/**
 * Downloads a file from Telegram by file path.
 */
export async function downloadTelegramFile(
  filePath: string
): Promise<Buffer | null> {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return null;
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e) {
    console.error('[telegram] download file error:', e);
    return null;
  }
}
