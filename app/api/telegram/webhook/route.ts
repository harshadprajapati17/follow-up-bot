import { NextRequest, NextResponse } from 'next/server';

const TELEGRAM_API_URL = 'https://api.telegram.org/bot';

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

    // Extract chat.id and message.text
    const chatId = update.message?.chat?.id;
    const messageText = update.message?.text;

    console.log('Extracted - Chat ID:', chatId, 'Message:', messageText);

    if (chatId && messageText) {
      console.log(`Processing message - Chat ID: ${chatId}, Message: ${messageText}`);
      
      // Send confirmation reply
      await sendTelegramMessage(chatId, 'Bot connected successfully.');
      console.log('Reply sent successfully');
    } else {
      console.log('No chatId or messageText found in update');
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
