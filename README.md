# Telegram Bot Webhook Integration

A Next.js (App Router) application with Telegram bot webhook integration.

## Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Configure Environment Variables

Create a `.env.local` file in the root directory:

```bash
cp env.example .env.local
```

Edit `.env.local` and add your Telegram bot token:

```
TELEGRAM_TOKEN=your_telegram_bot_token_here
```

**Getting a Telegram Bot Token:**
1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` command
3. Follow the instructions to create your bot
4. Copy the token provided by BotFather
5. Paste it in your `.env.local` file

### 3. Run Development Server

```bash
pnpm dev
```

The app will be available at `http://localhost:3000`

### 4. Set Up Webhook

To receive messages from Telegram, you need to set up the webhook URL. You can do this in several ways:

#### Option A: Using ngrok (for local development)

1. Install ngrok: https://ngrok.com/download
2. Sign up for a free account: https://dashboard.ngrok.com/signup
3. Get your authtoken: https://dashboard.ngrok.com/get-started/your-authtoken
4. Install your authtoken:
   ```bash
   ngrok config add-authtoken YOUR_AUTHTOKEN_HERE
   ```
5. Start ngrok tunnel:
   ```bash
   ngrok http 3000
   ```
6. Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)
7. Set the webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://htwpdl78-3000.inc1.devtunnels.ms//api/telegram/webhook"
   ```

#### Option B: Using localtunnel (for local development, no signup required)

1. Install localtunnel globally:
   ```bash
   pnpm add -g localtunnel
   ```
2. Start localtunnel:
   ```bash
   lt --port 3000
   ```
3. Copy the HTTPS URL provided (e.g., `https://random-name.loca.lt`)
4. Set the webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://random-name.loca.lt/api/telegram/webhook"
   ```

#### Option C: Deploy to Vercel (for production)

1. Deploy your app to Vercel:
   ```bash
   pnpm build
   vercel deploy
   ```
2. Add `TELEGRAM_TOKEN` to your Vercel environment variables in the dashboard
3. Set the webhook using your Vercel URL:
   ```bash
   curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://your-app.vercel.app/api/telegram/webhook"
   ```

## How It Works

- The webhook endpoint is located at `/api/telegram/webhook`
- When a user sends a message to your bot, Telegram sends a POST request to this endpoint
- The endpoint:
  - Logs the full update to the console
  - Extracts `chat.id` and `message.text`
  - Sends a confirmation reply: "Bot connected successfully."
  - Returns `{ ok: true }` as JSON response

## Project Structure

```
app/
├── api/
│   └── telegram/
│       └── webhook/
│           └── route.ts    # Webhook handler
├── .env.local              # Environment variables (not in git)
├── env.example             # Example environment file
└── package.json
```

## Testing

1. Send a message to your bot on Telegram
2. Check the console logs to see the incoming update
3. The bot should reply with "Bot connected successfully."

## Deployment

This app is ready for Vercel deployment. Make sure to:

1. Add `TELEGRAM_TOKEN` to your Vercel environment variables
2. Set the webhook URL to point to your deployed app
3. The webhook endpoint will automatically handle incoming messages
