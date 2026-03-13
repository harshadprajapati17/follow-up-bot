import { NextRequest, NextResponse } from 'next/server';
import { sendTelegramMessage, sendTelegramVoice } from '@/lib/telegram';
import { processVoiceMessage } from '@/lib/telegramVoice';
import { textToSpeech } from '@/lib/tts';
import { saveProjectConversation } from '@/lib/mongo';
import { handleProjectConversation } from '@/lib/projectConversation';

/**
 * GET — webhook health check
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
 * POST — Telegram webhook: parse update, run conversation/mongo, send reply.
 * All external service calls (Telegram, Mongo, S3, STT) are invoked from here via lib modules.
 * Spreadsheet recording is not used in this branch.
 */
export async function POST(request: NextRequest) {
  try {
    const update = await request.json();
    console.log('Received Telegram update:', JSON.stringify(update, null, 2));

    const chatId = update.message?.chat?.id;
    let messageText: string = update.message?.text ?? '';
    const firstName = update.message?.from?.first_name;
    const messageDate = update.message?.date;
    const voice = update.message?.voice;

    if (voice?.file_id) {
      messageText = await processVoiceMessage(voice);
    }

    // For conversation: use only the transcript when user sent voice (strip "Audio: url" suffix)
    const rawTextForConversation =
      messageText.includes('\nAudio:')
        ? messageText.split('\nAudio:')[0].trim()
        : messageText;

    console.log('Extracted - Chat ID:', chatId, 'Message:', messageText, 'From:', firstName);

    if (chatId) {
      const { replyText, savePayload } = await handleProjectConversation({
        chatId,
        rawText: rawTextForConversation,
        firstName,
        messageDate: messageDate ?? null,
      });

      if (savePayload) {
        await saveProjectConversation({
          chatId,
          firstName,
          messageDate: messageDate ?? null,
          payload: savePayload,
        });
      }

      const finalReplyText =
        replyText ??
        (voice?.file_id
          ? 'Voice message received and stored.'
          : messageText
            ? 'Bot connected successfully.'
            : null);

      if (finalReplyText) {
        // Conversation replies: send as voice (TTS). Fallback to text if TTS fails.
        if (replyText !== null) {
          const audioBuffer = await textToSpeech(finalReplyText, {
            target_language_code: 'hi-IN',
            output_format: 'mp3',
          });
          if (audioBuffer) {
            await sendTelegramVoice(chatId, audioBuffer, 'audio/mpeg');
          } else {
            await sendTelegramMessage(chatId, finalReplyText);
          }
        } else {
          await sendTelegramMessage(chatId, finalReplyText);
        }
      }
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
