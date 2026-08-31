import { next, rewrite } from '@vercel/functions';

// Soft link-share gate in front of the site. This is NOT the real access
// control — Supabase Auth (per-person sign-in, RLS on every table) is what
// actually protects the data. This just keeps the URL from being casually
// stumbled on or indexed before someone signs in.
const ACCESS_COOKIE = 'dashboard_access';
const ACCESS_CODE = 'bmv2026';
const ONE_YEAR = 60 * 60 * 24 * 365;

export const config = {
  matcher: ['/((?!_next/|images/|styles/|favicon.ico|config\\.js|404).*)'],
};

export default function middleware(request: Request) {
  const url = new URL(request.url);

  if (url.searchParams.get('access') === ACCESS_CODE) {
    url.searchParams.delete('access');
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.toString(),
        'Set-Cookie': `${ACCESS_COOKIE}=true; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ONE_YEAR}`,
      },
    });
  }

  const cookieHeader = request.headers.get('cookie') || '';
  const hasAccess = cookieHeader
    .split(';')
    .some((c) => c.trim() === `${ACCESS_COOKIE}=true`);

  if (!hasAccess) {
    return rewrite(new URL('/404', request.url));
  }

  return next();
}
