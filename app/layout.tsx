export const metadata = {
  title: 'Telegram Bot Webhook',
  description: 'Next.js app with Telegram bot integration',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
