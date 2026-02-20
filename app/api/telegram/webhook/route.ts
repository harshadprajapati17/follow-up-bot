import { NextRequest, NextResponse } from 'next/server';
import { readSheet, updateSheet } from '@/lib/googleSheets';
import { uploadVoiceToS3 } from '@/lib/s3';
import { transcribeAudio } from '@/lib/sarvamStt';

const TELEGRAM_API_URL = 'https://api.telegram.org/bot';

/** Column index for Owner (matches Telegram first_name). */
const OWNER_COLUMN_INDEX = 2; // column C

/**
 * GET handler for testing webhook endpoint
 */
export async function GET() {
  const token = process.env.TELEGRAM_TOKEN;
  return NextResponse.json({
    ok: true,
    message: 'Webhook endpoint is active',
    hasToken: !!token,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Sends a message to a Telegram chat using the Bot API
 */
async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_TOKEN;
  
  if (!token) {
    console.error('TELEGRAM_TOKEN is not set in environment variables');
    return;
  }

  const url = `${TELEGRAM_API_URL}${token}/sendMessage`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
      }),
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
 * Gets the file path for a Telegram file_id (e.g. voice message).
 * Returns the path to download from (e.g. "voice/file_0.ogg") or null.
 */
async function getTelegramFilePath(fileId: string): Promise<string | null> {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return null;
  const url = `${TELEGRAM_API_URL}${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok || !data.result?.file_path) return null;
    return data.result.file_path;
  } catch (e) {
    console.error('[webhook] getFile error:', e);
    return null;
  }
}

/**
 * Downloads a file from Telegram by file path.
 */
async function downloadTelegramFile(filePath: string): Promise<Buffer | null> {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return null;
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e) {
    console.error('[webhook] download file error:', e);
    return null;
  }
}

/** Format Telegram message date (Unix seconds) as DD-MM-YYYY HH:MM. */
function formatMessageDateTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}-${month}-${year} ${hours}:${minutes}`;
}

/** Convert column index to letter(s): 0=A, 1=B, ..., 25=Z, 26=AA, etc. */
function columnLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

/**
 * Finds the sheet row where Owner (column C) matches first_name.
 * Picks the next column after the last filled one (e.g. if last filled is C -> use D; if D -> use E).
 * That column: row 1 = date+time value (no heading), data row = text only.
 */
async function recordMessageInSheet(
  firstName: string,
  messageDate: number,
  messageText: string
): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID?.trim();
  if (!spreadsheetId) {
    console.log('[webhook] GOOGLE_SHEET_ID not set, skipping sheet update');
    return;
  }

  const range = 'A1:Z50';
  const rows = await readSheet(spreadsheetId, range);
  if (!rows || rows.length < 2) {
    console.log('[webhook] Sheet empty or no data rows, skipping');
    return;
  }

  const headerRow = rows[0];
  let lastFilledColIndex = -1;
  for (let c = 0; c < (headerRow?.length ?? 0); c++) {
    if (headerRow[c]?.trim()) lastFilledColIndex = c;
  }
  const newColIndex = lastFilledColIndex + 1;
  const colLetter = columnLetter(newColIndex);

  const normalizedName = firstName.trim().toLowerCase();
  let dataRowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    const owner = rows[i][OWNER_COLUMN_INDEX];
    if (owner && owner.trim().toLowerCase() === normalizedName) {
      dataRowIndex = i;
      break;
    }
  }

  if (dataRowIndex === -1) {
    console.log(`[webhook] No sheet row found for Owner "${firstName}", skipping`);
    return;
  }

  const sheetRowNumber = dataRowIndex + 1;
  const dateTimeStr = formatMessageDateTime(messageDate);
  const text = (messageText || '').trim() || '(no text)';

  // Row 1: date+time value (no "Date and time" heading)
  const row1Range = `${colLetter}1`;
  const headerOk = await updateSheet(spreadsheetId, row1Range, [[dateTimeStr]]);
  if (!headerOk) {
    console.error('[webhook] Failed to write date/time to row 1');
    return;
  }

  // Data row: text only (date/time is above in row 1)
  const cellRange = `${colLetter}${sheetRowNumber}`;
  const ok = await updateSheet(spreadsheetId, cellRange, [[text]]);
  if (ok) {
    console.log(`[webhook] Recorded last message for "${firstName}" at ${cellRange}`);
  } else {
    console.error('[webhook] Failed to write last message to sheet');
  }
}

/**
 * POST handler for Telegram webhook
 */
export async function POST(request: NextRequest) {
  console.log('=== Webhook endpoint called ===');
  console.log('Method:', request.method);
  console.log('URL:', request.url);
  
  try {
    const update = await request.json();

    // Log the full update
    console.log('Received Telegram update:', JSON.stringify(update, null, 2));

    // Extract from webhook payload: chat, message text (or voice), sender, and message date
    const chatId = update.message?.chat?.id;
    let messageText: string = update.message?.text ?? '';
    const firstName = update.message?.from?.first_name;
    const messageDate = update.message?.date; // Unix seconds
    const voice = update.message?.voice;

    // If this is a voice message: download, upload to S3, transcribe with Sarvam STT, store text + audio link
    if (voice?.file_id) {
      const filePath = await getTelegramFilePath(voice.file_id);
      if (filePath) {
        const audioBuffer = await downloadTelegramFile(filePath);
        if (audioBuffer) {
          const mimeType = voice.mime_type ?? 'audio/ogg';
          const ext = mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3' : 'ogg';
          const s3Url = await uploadVoiceToS3(
            audioBuffer,
            voice.file_unique_id ?? voice.file_id,
            mimeType,
            ext
          );

          // Transcribe with Sarvam AI Speech-to-Text (supports Indian languages + English)
          const transcript = await transcribeAudio(
            audioBuffer,
            mimeType,
            `voice.${ext}`,
            { language_code: 'unknown' } // auto-detect language
          );

          if (s3Url) {
            if (transcript) {
              messageText = `${transcript}\nAudio: ${s3Url}`;
              console.log('Voice message transcribed and stored at', s3Url);
            } else {
              messageText = `[Transcription unavailable]\nAudio: ${s3Url}`;
              console.log('Voice message stored at', s3Url, '(STT failed or returned empty)');
            }
          } else {
            messageText = transcript
              ? `${transcript}\n[Audio: S3 upload failed]`
              : '[Voice message – S3 upload failed]';
          }
        } else {
          messageText = '[Voice message – download failed]';
        }
      } else {
        messageText = '[Voice message – getFile failed]';
      }
    }

    console.log('Extracted - Chat ID:', chatId, 'Message:', messageText, 'From:', firstName);

    // Record in sheet: date (DD-MM-YYYY) + message text in "Last message" column
    if (firstName && messageDate != null) {
      await recordMessageInSheet(firstName, messageDate, messageText);
    }

    if (chatId) {
      const replyText = voice?.file_id
        ? 'Voice message received and stored.'
        : messageText
          ? 'Bot connected successfully.'
          : null;
      if (replyText) {
        console.log(`Sending reply - Chat ID: ${chatId}`);
        await sendTelegramMessage(chatId, replyText);
        console.log('Reply sent successfully');
      } else {
        console.log('No chatId or message text/voice found in update');
      }
    } else {
      console.log('No chatId found in update');
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message, error.stack);
    }
    return NextResponse.json(
      { ok: false, error: 'Invalid request' },
      { status: 400 }
    );
  }
}
