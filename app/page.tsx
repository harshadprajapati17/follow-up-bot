export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">AI Assistant Backend</h1>
        <p className="text-lg text-gray-600 mb-6">
          This branch is a minimal backend focused on two pieces:
        </p>
        <ul className="mx-auto mb-8 max-w-xl text-left text-gray-700 space-y-3">
          <li>
            <span className="font-semibold">1. Telegram webhook</span>{" "}
            <code className="bg-gray-100 px-2 py-1 rounded text-sm">
              /api/telegram/webhook
            </code>
          </li>
          <li>
            <span className="font-semibold">2. Text-to-Speech (Sarvam TTS)</span>{" "}
            <code className="bg-gray-100 px-2 py-1 rounded text-sm">
              /api/tts
            </code>
          </li>
        </ul>
        <p className="text-sm text-gray-500">
          Configure environment variables for Telegram, Sarvam, Google Sheets and S3,
          then point your Telegram bot webhook to{" "}
          <code className="bg-gray-100 px-2 py-1 rounded text-xs">
            /api/telegram/webhook
          </code>
          .
        </p>
      </div>
    </main>
  )
}
