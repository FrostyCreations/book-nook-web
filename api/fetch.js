// Runs on Vercel. Fetches book files and search results from the free libraries on the app's behalf,
// because browsers are not allowed to download directly from most of them.
// Only the libraries listed below can be reached through it.

export const config = { runtime: 'edge' };

const ALLOWED_HOSTS = [
  'gutenberg.org',
  'archive.org',
  'openlibrary.org',
  'wikisource.org',
  'library.oapen.org',
  'bookdash.org',
  'storyweaver.org.in',
  'storage.googleapis.com'
];

function isAllowed(url) {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed));
}

export default async function handler(request) {
  const target = new URL(request.url).searchParams.get('url');
  let url;
  try {
    url = new URL(target);
  } catch (error) {
    return new Response('Missing or invalid address.', { status: 400 });
  }

  // Follow redirects by hand so every hop stays inside the allowed libraries.
  let response;
  for (let hop = 0; hop < 6; hop += 1) {
    if (!isAllowed(url)) {
      return new Response('That website is not one of the libraries this app uses.', { status: 403 });
    }
    response = await fetch(url.toString(), {
      redirect: 'manual',
      headers: {
        'User-Agent': 'BookNook/1.0 (personal reading web app)',
        Accept: request.headers.get('accept') || '*/*'
      }
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location'), url);
      continue;
    }
    break;
  }

  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'last-modified']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', response.ok ? 'public, max-age=3600' : 'no-store');
  return new Response(response.body, { status: response.status, headers });
}
