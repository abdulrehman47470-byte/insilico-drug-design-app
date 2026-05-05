import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'InSilico Drug Design | Disease → Drug Pipeline',
  description: 'AI-powered in-silico drug discovery pipeline. From disease name to ranked drug candidates with molecular docking, ADME profiling, and target analysis.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  )
}
