import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  const { disease } = await req.json()
  if (!disease?.trim()) {
    return NextResponse.json({ error: 'Disease name is required' }, { status: 400 })
  }
  const webhookUrl = process.env.N8N_WEBHOOK_URL
  if (!webhookUrl) {
    return NextResponse.json({ error: 'N8N_WEBHOOK_URL not configured' }, { status: 500 })
  }
  try {
    const sessionId = `dd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const n8nRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatInput: disease.trim(), sessionId }),
      signal: AbortSignal.timeout(290_000),
    })
    if (!n8nRes.ok) {
      const text = await n8nRes.text().catch(() => '')
      return NextResponse.json(
        { error: `n8n pipeline failed (HTTP ${n8nRes.status}): ${text.slice(0, 200)}` },
        { status: 502 }
      )
    }
    const raw = await n8nRes.json()
    const data = Array.isArray(raw) ? raw[0] : raw
    return NextResponse.json({
      output: data?.output ?? '',
      final_report: data?.final_report ?? data,
      sessionId,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg.includes('TimeoutError') || msg.includes('AbortError')) {
      return NextResponse.json({ error: 'Pipeline timeout — n8n took longer than 5 minutes.' }, { status: 504 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
