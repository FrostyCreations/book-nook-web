// One small "source" per free library. Each knows how to search that library and where its files live.
// To add a library, write another source object and add it to SOURCES.

const PROXY = 'api/fetch?url=';

/**
 * Fetches a library address. Some libraries allow the browser to ask directly; the rest go through
 * the app's own helper (api/fetch.js on Vercel). If the first way fails, the other is tried.
 */
export async function libraryFetch(url, { direct = false, accept } = {}) {
  const headers = accept ? { Accept: accept } : {};
  const viaProxy = () => fetch(PROXY + encodeURIComponent(url), { headers });
  const straight = () => fetch(url, { headers });
  // The Internet Archive's own browser-friendly addresses never need (or accept) the helper.
  const browserFriendly = /^https:\/\/archive\.org\/(cors|metadata)\//.test(url);
  const order = browserFriendly ? [straight] : direct ? [straight, viaProxy] : [viaProxy, straight];
  let lastError = null;
  let lastStatus = 0;
  for (const attempt of order) {
    try {
      const response = await attempt();
      if (response.ok) return response;
      lastStatus = response.status;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(friendlyStatus(lastStatus, lastError));
  error.status = lastStatus;
  throw error;
}

function friendlyStatus(status, error) {
  if (!navigator.onLine) return "The iPad isn't connected to the internet.";
  if (status === 404) return "That file isn't available from this library.";
  if (status === 429) return 'This library is busy right now. Try again in a minute.';
  if (status === 403) return "This library won't answer the app right now.";
  if (status) return `The library's website answered with an error (${status}).`;
  return (error && error.name === 'TimeoutError') ? "The library's website took too long to answer."
    : "The library's website can't be reached right now.";
}

const json = async (url, options) => {
  const response = await libraryFetch(url, { accept: 'application/json', ...options });
  try {
    return await response.json();
  } catch (error) {
    throw new Error("This library sent back something the app couldn't read. Try again in a minute.");
  }
};
const query = (base, params) => base + '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const joined = (parts) => parts.filter(Boolean).join(' · ');
const text = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ');
  if (typeof value === 'number') return String(value);
  return '';
};

export function plainText(html) {
  const holder = document.createElement('textarea');
  holder.innerHTML = String(html).replace(/<[^>]*>/g, '');
  return holder.value.split(/\s+/).filter(Boolean).join(' ');
}

const LANGUAGES = { eng: 'English', afr: 'Afrikaans', dut: 'Dutch', nld: 'Dutch', fre: 'French', fra: 'French',
  ger: 'German', deu: 'German', spa: 'Spanish', ita: 'Italian', por: 'Portuguese', zul: 'isiZulu', xho: 'isiXhosa',
  sot: 'Sesotho', lat: 'Latin' };

// --- Project Gutenberg: 75,000+ public domain books, proofread by volunteers.
const gutenberg = {
  id: 'gutenberg',
  name: 'Project Gutenberg',
  blurb: 'Classic books, carefully proofread',
  browse: true,
  async search(words, { subject } = {}) {
    // "s.vampires" asks Gutenberg for books filed under that subject.
    const url = query('https://www.gutenberg.org/ebooks/search.opds/', [['query', subject ? `s.${subject}` : words]]);
    const feed = await (await libraryFetch(url, { direct: true, accept: 'application/atom+xml' })).text();
    const doc = new DOMParser().parseFromString(feed, 'application/xml');
    const results = [];
    for (const entry of doc.getElementsByTagName('entry')) {
      const id = (entry.getElementsByTagName('id')[0] || {}).textContent || '';
      const match = id.match(/\/ebooks\/(\d+)\.opds/);
      if (!match) continue;                               // skips the "Authors" and "Subjects" rows
      const number = match[1];
      results.push({
        id: `gutenberg:${number}`,
        title: ((entry.getElementsByTagName('title')[0] || {}).textContent || 'Untitled').trim(),
        author: ((entry.getElementsByTagName('content')[0] || {}).textContent || '').trim().replace(/^\d+ downloads$/, ''),
        detail: '',
        source: 'Project Gutenberg',
        cover: `https://www.gutenberg.org/cache/epub/${number}/pg${number}.cover.medium.jpg`,
        downloads: [{ label: 'EPUB', format: 'epub', url: `https://www.gutenberg.org/ebooks/${number}.epub3.images` }],
        web: `https://www.gutenberg.org/ebooks/${number}`
      });
    }
    return results;
  }
};

// --- Internet Archive: millions of scanned books.
// Only books scanned by libraries are searched. Anyone can upload files to the Archive, and those
// uploads sometimes include books that are still in copyright, so they are deliberately left out,
// as are lending-only titles.
const LIBRARY_SCANS = 'collection:(americana OR toronto OR europeanlibraries OR library_of_congress OR gutenberg)';
const archive = {
  id: 'archive',
  name: 'Internet Archive',
  blurb: 'Old books scanned by libraries',
  browse: true,
  async search(words, { subject } = {}) {
    const clean = (subject || words).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!clean) return [];
    const q = `${subject ? `subject:(${clean})` : `(title:(${clean}) OR creator:(${clean}))`} AND mediatype:texts AND ${LIBRARY_SCANS}`
      + ' AND -collection:(inlibrary) AND -collection:(printdisabled) AND -access-restricted-item:true';
    const url = query('https://archive.org/advancedsearch.php', [['q', q],
      ['fl[]', 'identifier'], ['fl[]', 'title'], ['fl[]', 'creator'], ['fl[]', 'year'], ['fl[]', 'language'],
      ['fl[]', 'format'], ['sort[]', 'downloads desc'], ['rows', '30'], ['output', 'json']]);
    const data = await json(url, { direct: true });
    const results = [];
    for (const doc of (data.response && data.response.docs) || []) {
      if (!doc.identifier) continue;
      const id = encodeURIComponent(doc.identifier);
      const formats = doc.format || [];
      const downloads = [];
      if (formats.includes('EPUB')) downloads.push({ label: 'EPUB (text)', format: 'epub', url: `https://archive.org/download/${id}/${id}.epub` });
      if (formats.some((f) => f.endsWith('Text PDF'))) downloads.push({ label: 'PDF (page scans)', format: 'pdf', url: `https://archive.org/download/${id}/${id}.pdf` });
      if (!downloads.length) continue;
      results.push({
        id: `ia:${doc.identifier}`,
        title: text(doc.title) || doc.identifier,
        author: text(doc.creator),
        detail: joined([text(doc.year), LANGUAGES[text(doc.language).toLowerCase()] || text(doc.language)]),
        source: 'Internet Archive',
        cover: `https://archive.org/services/img/${id}`,
        coverFile: archiveCover(doc.identifier),
        downloads,
        web: `https://archive.org/details/${id}`
      });
    }
    return results;
  }
};

// --- Open Library: the Internet Archive's catalogue. Better at finding the right edition of a known book.
const openLibrary = {
  id: 'openlibrary',
  name: 'Open Library',
  blurb: 'Finds free editions of well-known books',
  browse: true,
  async search(words, { subject } = {}) {
    const url = query('https://openlibrary.org/search.json', [['q', `${subject ? `subject:"${subject}"` : words} ebook_access:public`],
      ['fields', 'key,title,author_name,cover_i,first_publish_year,editions,editions.key,editions.title,editions.ia,editions.ebook_access'],
      ['limit', '25']]);
    const data = await json(url, { direct: true });
    const results = [];
    for (const doc of data.docs || []) {
      const edition = ((doc.editions && doc.editions.docs) || []).find((e) => e.ebook_access === 'public');
      const identifier = edition && (edition.ia || []).find((name) => !name.toLowerCase().includes('librivox'));
      if (!identifier) continue;
      const id = encodeURIComponent(identifier);
      results.push({
        id: `ia:${identifier}`,
        title: text(doc.title),
        author: text(doc.author_name),
        detail: text(doc.first_publish_year),
        source: 'Open Library',
        cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : `https://archive.org/services/img/${id}`,
        coverFile: archiveCover(identifier),
        downloads: [
          { label: 'EPUB (text)', format: 'epub', url: `https://archive.org/download/${id}/${id}.epub` },
          { label: 'PDF (page scans)', format: 'pdf', url: `https://archive.org/download/${id}/${id}.pdf` }],
        web: `https://openlibrary.org${doc.key || ''}`
      });
    }
    return results;
  }
};

// --- Open Library lending: newer books that are still in copyright, lent out the way a library lends
// paper books. She borrows and reads them on the Open Library website with a free account; they can't
// be downloaded to the shelf. Only English editions are listed.
const lending = {
  id: 'lending',
  name: 'Open Library lending',
  blurb: 'Newer books to borrow free, like a library',
  browse: true,
  async search(words, { subject } = {}) {
    const url = query('https://openlibrary.org/search.json', [
      ['q', `${subject ? `subject:"${subject}"` : words} ebook_access:borrowable language:eng`],
      ['fields', 'key,title,author_name,cover_i,first_publish_year,editions,editions.key,editions.ebook_access,editions.language'],
      ['limit', '25']]);
    const data = await json(url, { direct: true });
    const results = [];
    for (const doc of data.docs || []) {
      const edition = ((doc.editions && doc.editions.docs) || [])
        .find((e) => e.ebook_access === 'borrowable' && (e.language || []).includes('eng') && e.key);
      if (!edition) continue;
      results.push({
        id: `lending:${edition.key}`,
        title: text(doc.title),
        author: text(doc.author_name),
        detail: joined([text(doc.first_publish_year), 'Borrow and read online, free account needed']),
        source: 'Open Library lending',
        cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
        downloads: [],
        web: `https://openlibrary.org${edition.key}`,
        webLabel: 'Borrow'
      });
    }
    return results;
  }
};

// --- Wikisource: hand-typed texts from Wikipedia's sister library.
const wikisource = (language, languageName) => ({
  id: `wikisource-${language}`,
  name: language === 'en' ? 'Wikisource' : `Wikisource (${languageName})`,
  blurb: `Hand-typed texts in ${languageName}`,
  async search(words) {
    const url = query(`https://${language}.wikisource.org/w/api.php`, [['action', 'query'], ['list', 'search'],
      ['srsearch', words], ['srnamespace', '0'], ['srlimit', '30'], ['format', 'json'], ['origin', '*']]);
    const data = await json(url, { direct: true });
    const seen = new Set();
    const results = [];
    for (const hit of (data.query && data.query.search) || []) {
      const title = (hit.title || '').split('/')[0];      // "Book/Chapter 3" belongs to "Book"
      if (!title || seen.has(title)) continue;
      seen.add(title);
      const page = title.replace(/ /g, '_');
      results.push({
        id: `wikisource:${language}:${title}`,
        title,
        author: '',
        detail: languageName,
        source: this.name,
        cover: null,
        // Wikisource's EPUB maker refuses requests from the app's download helper, so these open on
        // the website instead. Its "Download" button there gives an EPUB that "Add a file" accepts.
        downloads: [],
        web: `https://${language}.wikisource.org/wiki/${encodeURIComponent(page)}`,
        webLabel: 'Read on Wikisource'
      });
    }
    return results;
  }
});

// --- OAPEN: free academic and non-fiction books from university presses (mostly PDF).
const oapen = {
  id: 'oapen',
  name: 'OAPEN',
  blurb: 'Free non-fiction and study books',
  async search(words) {
    const host = 'https://library.oapen.org';
    const data = await json(query(`${host}/rest/search`, [['query', words], ['expand', 'metadata,bitstreams'], ['limit', '20']]));
    const results = [];
    for (const item of Array.isArray(data) ? data : []) {
      const meta = {};
      for (const entry of item.metadata || []) (meta[entry.key] = meta[entry.key] || []).push(entry.value);
      const downloads = [];
      let cover = null;
      for (const stream of item.bitstreams || []) {
        if (!stream.retrieveLink) continue;
        const url = host + stream.retrieveLink;
        if (stream.bundleName === 'THUMBNAIL') cover = cover || url;
        else if (stream.bundleName === 'ORIGINAL') {
          if (stream.mimeType === 'application/pdf') downloads.push({ label: 'PDF', format: 'pdf', url });
          else if (stream.mimeType === 'application/epub+zip') downloads.unshift({ label: 'EPUB', format: 'epub', url });
        }
      }
      const title = (meta['dc.title'] || [])[0] || item.name;
      const id = item.uuid || item.handle;
      if (!title || !id) continue;
      results.push({
        id: `oapen:${id}`,
        title: title.split(/\s+/).join(' '),
        author: (meta['dc.contributor.author'] || meta['dc.contributor.editor'] || []).join(', '),
        detail: joined([((meta['dc.date.issued'] || [])[0] || '').slice(0, 4), 'Open access']),
        source: 'OAPEN',
        cover,
        downloads: downloads.slice(0, 2),
        web: item.handle ? `${host}/handle/${item.handle}` : null
      });
    }
    return results;
  }
};

// --- Book Dash: South African picture books in all the official languages. They open on the Book Dash website.
const bookDash = {
  id: 'bookdash',
  name: 'Book Dash',
  blurb: 'South African picture books',
  async search(words) {
    const data = await json(query('https://bookdash.org/wp-json/wp/v2/search', [['search', words], ['per_page', '20'], ['subtype', 'books']]), { direct: true });
    return (Array.isArray(data) ? data : []).filter((item) => item.subtype === 'books' && item.url && item.title).map((item) => ({
      id: `bookdash:${item.id}`,
      title: plainText(item.title),
      author: '',
      detail: 'Picture book',
      source: 'Book Dash',
      cover: null,
      downloads: [],
      web: item.url
    }));
  }
};

// --- StoryWeaver: thousands of openly licensed children's stories. They open on the StoryWeaver website.
const storyWeaver = {
  id: 'storyweaver',
  name: 'StoryWeaver',
  blurb: "Children's stories in many languages",
  async search(words) {
    const data = await json(query('https://storyweaver.org.in/api/v1/books-search', [['query', words], ['per_page', '20']]));
    return ((data && data.data) || []).filter((item) => item.slug).map((item) => ({
      id: `storyweaver:${item.slug}`,
      title: text(item.title),
      author: (item.authors || []).map((a) => a.name).filter(Boolean).join(', '),
      detail: joined([text(item.language), item.level ? `Reading level ${item.level}` : '']),
      source: 'StoryWeaver',
      cover: (((item.coverImage || {}).sizes || [])[0] || {}).url || null,
      downloads: [],
      web: `https://storyweaver.org.in/en/stories/${item.slug}`
    }));
  }
};

/** Shelves to browse when she doesn't have a title in mind. `subject` is the library catalogue heading. */
export const MOODS = [
  { label: 'Vampires', subject: 'vampires' },
  { label: 'Gothic romance', subject: 'gothic fiction' },
  { label: 'Love stories', subject: 'love stories' },
  { label: 'Fantasy', subject: 'fantasy fiction' },
  { label: 'Ghost stories', subject: 'ghost stories' },
  { label: 'Mysteries', subject: 'detective and mystery stories' },
  { label: 'Adventure', subject: 'adventure stories' },
  { label: 'Fairy tales', subject: 'fairy tales' }
];

/**
 * Internet Archive files are downloaded straight from the Archive by the browser, using the
 * Archive's browser-friendly address (archive.org/cors/…). The app's download helper can't be used
 * for them: the Archive turns away requests that come from Vercel.
 * The Archive's catalogue is asked first for the file's real name.
 */
async function archiveFileAddress(identifier, format) {
  const id = encodeURIComponent(identifier);
  let name = `${identifier}.${format}`;
  try {
    const meta = await json(`https://archive.org/metadata/${id}`, { direct: true });
    const files = meta.files || [];
    const pdf = (f) => /\.pdf$/i.test(f.name || '');
    const file = format === 'epub'
      ? files.find((f) => f.format === 'EPUB') || files.find((f) => /\.epub$/i.test(f.name || ''))
      : files.find((f) => f.format === 'Text PDF') || files.find((f) => f.format === 'Additional Text PDF')
        || files.find((f) => pdf(f) && !/_bw\.pdf$/i.test(f.name)) || files.find(pdf);
    if (files.length && !file) {
      throw Object.assign(new Error(format === 'epub'
        ? 'This edition has no EPUB file. Try its PDF, or another edition.'
        : 'This edition has no PDF file. Try another edition.'), { final: true });
    }
    if (file) name = file.name;
  } catch (error) {
    if (error.final) throw error;      // otherwise fall back to the usual file name
  }
  return `https://archive.org/cors/${id}/${name.split('/').map(encodeURIComponent).join('/')}`;
}

/** The small cover picture the Archive keeps for every book, at an address the browser may fetch. */
const archiveCover = (identifier) => `https://archive.org/cors/${encodeURIComponent(identifier)}/__ia_thumb.jpg`;

/** Downloads the file behind a result's download button. Returns a Blob. */
export async function fetchBookFile(option) {
  const archived = option.url.match(/^https:\/\/archive\.org\/download\/([^/]+)\//);
  if (!archived) return (await libraryFetch(option.url)).blob();
  const address = await archiveFileAddress(decodeURIComponent(archived[1]), option.format);
  return (await libraryFetch(address)).blob();
}

export const SOURCES = [gutenberg, openLibrary, archive, lending, wikisource('en', 'English'), wikisource('af', 'Afrikaans'),
  oapen, bookDash, storyWeaver];

/** Looks at the first bytes of a file to tell what it really is. Returns 'epub', 'pdf' or null. */
export async function sniffFormat(blob) {
  const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4B) return 'epub';
  const start = new TextDecoder('latin1').decode(head);
  if (start.includes('%PDF-')) return 'pdf';
  return null;
}
