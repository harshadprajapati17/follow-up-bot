/**
 * Cron Job API Route
 * ------------------
 * Handles morning/evening sync: read task from sheet (B2), convert to speech via TTS,
 * send voice to Telegram, then update sheet with sent status.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readSheet, updateSheet } from '@/lib/googleSheets';

const TELEGRAM_API_URL = 'https://api.telegram.org/bot';

/** 2nd row, 2nd column = task details (B2). */
const TASK_ROW_INDEX = 1;
const TASK_COL_INDEX = 1;

/** Row in sheet where we write "Morning sync sent" (same as task row = row 2). */
const MORNING_SYNC_DATA_ROW_INDEX = 1;

function columnLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

function formatMessageDateTime(unixSeconds?: number): string {
  const d = unixSeconds ? new Date(unixSeconds * 1000) : new Date();
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}-${month}-${year} ${hours}:${minutes}`;
}

/**
 * Convert task text to audio using Sarvam TTS (same as /api/tts).
 * Returns audio buffer (mp3) or null.
 */
async function textToAudioBuffer(text: string): Promise<Buffer | null> {
  const apiKey = process.env.SARVAM_API_KEY?.trim();
  if (!apiKey) {
    console.error('[cron-job] SARVAM_API_KEY not set');
    return null;
  }
  const payload = {
    text: text.trim(),
    target_language_code: 'en-IN',
    speaker: 'ratan',
    model: 'bulbul:v3',
    pace: 1,
    sample_rate: 24000,
    output_format: 'mp3',
  };
  try {
    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': apiKey,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('[cron-job] TTS error', res.status, errText);
      return null;
    }
    const data = await res.json();
    const audios = data?.audios;
    const first = Array.isArray(audios) && audios.length > 0 ? audios[0] : undefined;
    const audioBase64 =
      typeof first === 'string'
        ? first
        : first && typeof first === 'object'
          ? (first as { audio_content?: string; audio?: string }).audio_content ??
            (first as { audio?: string }).audio
          : undefined;
    const resolved =
      audioBase64 ?? data?.audio_content ?? data?.audioBase64 ?? data?.audio;
    if (!resolved || typeof resolved !== 'string') return null;
    return Buffer.from(resolved, 'base64');
  } catch (err) {
    console.error('[cron-job] TTS request failed:', err);
    return null;
  }
}

/**
 * Send audio to Telegram as voice message (sendVoice) or as audio file (sendAudio).
 * Uses sendAudio so we can send mp3; sendVoice prefers ogg/opus.
 */
async function sendAudioToTelegram(chatId: string, audioBuffer: Buffer): Promise<boolean> {
  const token = process.env.TELEGRAM_TOKEN?.trim();
  if (!token) {
    console.error('[cron-job] TELEGRAM_TOKEN not set');
    return false;
  }
  const url = `${TELEGRAM_API_URL}${token}/sendVoice`;
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('voice', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/mpeg' }), 'morning-task.mp3');
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[cron-job] Telegram sendVoice failed:', res.status, err);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[cron-job] Telegram request failed:', err);
    return false;
  }
}

/**
 * Find next empty column and write: row 1 = date/time, row 2 = status text.
 * Same logic as webhook recordMessageInSheet but for a fixed data row (morning sync).
 */
async function recordMorningSyncInSheet(statusText: string): Promise<boolean> {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID?.trim();
  if (!spreadsheetId) {
    console.log('[cron-job] GOOGLE_SHEET_ID not set, skipping sheet update');
    return false;
  }
  const range = 'A1:Z50';
  const rows = await readSheet(spreadsheetId, range);
  if (!rows || rows.length < 2) {
    console.log('[cron-job] Sheet empty or no data rows');
    return false;
  }
  const headerRow = rows[0];
  let lastFilledColIndex = -1;
  for (let c = 0; c < (headerRow?.length ?? 0); c++) {
    if (headerRow[c]?.trim()) lastFilledColIndex = c;
  }
  const newColIndex = lastFilledColIndex + 1;
  const colLetter = columnLetter(newColIndex);
  const dateTimeStr = formatMessageDateTime();

  const row1Range = `${colLetter}1`;
  const headerOk = await updateSheet(spreadsheetId, row1Range, [[dateTimeStr]]);
  if (!headerOk) {
    console.error('[cron-job] Failed to write date/time to row 1');
    return false;
  }
  const sheetRowNumber = MORNING_SYNC_DATA_ROW_INDEX + 1;
  const cellRange = `${colLetter}${sheetRowNumber}`;
  const ok = await updateSheet(spreadsheetId, cellRange, [[statusText]]);
  if (ok) {
    console.log('[cron-job] Recorded morning sync at', cellRange);
  }
  return ok;
}

/**
 * POST /api/cron-job
 * Body: { type: 'morning' | 'evening' }
 *
 * 1. Read sheet, get task from 2nd column 2nd row (B2).
 * 2. Convert task text to audio via TTS.
 * 3. Send audio to Telegram (TELEGRAM_CHAT_ID).
 * 4. Update sheet: next column, row 1 = date/time, row 2 = "Morning sync sent".
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const type = (body?.type ?? 'morning') as string;
    if (type !== 'morning' && type !== 'evening') {
      return NextResponse.json(
        { success: false, error: 'Invalid type. Use "morning" or "evening".' },
        { status: 400 }
      );
    }

    const spreadsheetId = process.env.GOOGLE_SHEET_ID?.trim();
    if (!spreadsheetId) {
      return NextResponse.json(
        { success: false, error: 'GOOGLE_SHEET_ID not set.' },
        { status: 503 }
      );
    }

    const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || '752858351';

    // 1. Retrieve sheet and get task from B2 (2nd row, 2nd column)
    const range = 'A1:Z20';
    const rows = await readSheet(spreadsheetId, range);
    if (!rows || rows.length <= TASK_ROW_INDEX) {
      return NextResponse.json(
        { success: false, error: 'Sheet empty or no row 2. Add task in cell B2.' },
        { status: 400 }
      );
    }
    const taskText = (rows[TASK_ROW_INDEX][TASK_COL_INDEX] ?? '').trim();
    if (!taskText) {
      return NextResponse.json(
        { success: false, error: 'No task found at B2 (2nd row, 2nd column).' },
        { status: 400 }
      );
    }

    // 2. Convert task to audio (TTS) — prepend Hindi intro
    const intro = 'नमस्ते, आज आपका काम है    ';
    const textForTTS = intro + taskText;
    const audioBuffer = await textToAudioBuffer(textForTTS);
    if (!audioBuffer || audioBuffer.length === 0) {
      return NextResponse.json(
        { success: false, error: 'TTS failed: could not generate audio from task.' },
        { status: 502 }
      );
    }

    // 3. Send audio to Telegram
    const sent = await sendAudioToTelegram(chatId, audioBuffer);
    if (!sent) {
      return NextResponse.json(
        { success: false, error: 'Failed to send voice message to Telegram.' },
        { status: 502 }
      );
    }

    // 4. Update sheet: next column with date and status
    const statusLabel = type === 'morning' ? 'Morning sync sent' : 'Evening sync sent';
    await recordMorningSyncInSheet(statusLabel);

    return NextResponse.json({
      success: true,
      message: `${type} sync completed: task sent as voice to Telegram and sheet updated.`,
    });
  } catch (err) {
    console.error('[cron-job] Error:', err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'Cron job failed.',
      },
      { status: 500 }
    );
  }
}
