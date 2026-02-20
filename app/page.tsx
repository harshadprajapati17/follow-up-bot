export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">Telegram Bot Webhook</h1>
        <p className="text-lg text-gray-600">
          Webhook endpoint: <code className="bg-gray-100 px-2 py-1 rounded">/api/telegram/webhook</code>
        </p>
      </div>
    </main>
  )
}
