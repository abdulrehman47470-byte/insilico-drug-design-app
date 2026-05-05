import { NextRequest, NextResponse } from 'next/server'

export function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD
  if (!password) return NextResponse.next()
  if (req.nextUrl.pathname.startsWith('/api/')) return NextResponse.next()
  const cookie = req.cookies.get('dd_auth')?.value
  if (cookie === password) return NextResponse.next()
  const auth = req.headers.get('authorization') ?? ''
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString()
    const [, pass] = decoded.split(':')
    if (pass === password) {
      const res = NextResponse.next()
      res.cookies.set('dd_auth', password, { httpOnly: true, sameSite: 'lax', maxAge: 86400 * 7 })
      return res
    }
  }
  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="InSilico Drug Design"' },
  })
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
