/**
 * Speech-to-Text API Route (Sarvam AI)
 * ------------------------------------
 * Accepts an audio file (multipart/form-data), transcribes via Sarvam STT,
 * and returns the transcript. Used by the web chat voice input.
 *
 * POST /api/stt
 * Body: multipart/form-data with field "file" (audio file)
 * Success: { success: true, transcript: string }
 * Error:   { success: false, error: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { transcribeAudio } from '@/lib/sarvamStt';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid "file" in form data.' },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    // Sarvam accepts "audio/webm" but not "audio/webm;codecs=opus" — normalize to allowed type
    const rawType = file.type || 'audio/webm';
    const mimeType =
      rawType === 'audio/webm;codecs=opus' || rawType.startsWith('audio/webm')
        ? 'audio/webm'
        : rawType;
    const filename =
      file.name || (mimeType.includes('ogg') ? 'voice.ogg' : 'voice.webm');

    const transcript = await transcribeAudio(buffer, mimeType, filename);

    if (transcript === null) {
      return NextResponse.json(
        {
          success: false,
          error: 'Transcription failed. Check SARVAM_API_KEY and audio format (e.g. webm, ogg).',
        },
        { status: 502 }
      );
    }

    return NextResponse.json(
      { success: true, transcript },
      { status: 200 }
    );
  } catch (err) {
    console.error('[api/stt] Error:', err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'STT request could not be processed.',
      },
      { status: 400 }
    );
  }
}
