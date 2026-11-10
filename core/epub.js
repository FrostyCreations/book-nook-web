// Reading EPUB files (find the chapters, contents list and cover) and writing new ones (for scanned books).
// Uses JSZip, loaded from vendor/jszip.min.js.

const zipLib = () => globalThis.JSZip;

const ENTITIES = { nbsp: 160, copy: 169, reg: 174, laquo: 171, raquo: 187, ndash: 8211, mdash: 8212, lsquo: 8216,
  rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, hellip: 8230, bull: 8226, trade: 8482, deg: 176,
  middot: 183, eacute: 233, egrave: 232, ecirc: 234, euml: 235, aacute: 225, agrave: 224, acirc: 226, auml: 228,
  ccedil: 231, iuml: 239, icirc: 238, ocirc: 244, ouml: 246, ucirc: 251, uuml: 252, ntilde: 241, szlig: 223,
  times: 215, frac12: 189, pound: 163, euro: 8364, sect: 167, shy: 173, ensp: 8194, emsp: 8195, thinsp: 8201 };

export const escapeXML = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const squash = (text) => (text || '').split(/\s+/).filter(Boolean).join(' ');

function parseXML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

/** XHTML often uses HTML-only entities such as &nbsp; that strict XML rejects. Swap them for numbers. */
function parseXHTML(text) {
  let doc = parseXML(text);
  if (doc) return doc;
  const fixed = text.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => (ENTITIES[name] ? `&#${ENTITIES[name]};` : match));
  doc = parseXML(fixed);
  return doc;
}

const byLocalName = (node, name) => [...node.getElementsByTagName('*')].filter((el) => el.localName === name);
const childrenNamed = (node, name) => [...node.children].filter((el) => el.localName === name);

/** Turns "../text/ch1.xhtml#p3" (seen from inside `baseDir`) into { path, fragment }. */
export function resolvePath(href, baseDir) {
  let path = href;
  let fragment = null;
  const hash = path.indexOf('#');
  if (hash >= 0) { fragment = path.slice(hash + 1) || null; path = path.slice(0, hash); }
  try { path = decodeURIComponent(path); } catch (error) { /* keep as written */ }
  if (!path) return { path: '', fragment };
  const parts = path.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
  for (const piece of path.split('/')) {
    if (!piece || piece === '.') continue;
    if (piece === '..') parts.pop(); else parts.push(piece);
  }
  return { path: parts.join('/'), fragment };
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export class NotABookError extends Error {}

/** Opens an EPUB (a Blob or ArrayBuffer) and reads its structure. */
export async function openEpub(data) {
  let zip;
  try {
    zip = await zipLib().loadAsync(data);
  } catch (error) {
    throw new NotABookError('This file could not be opened as an EPUB.');
  }
  const read = async (path) => {
    const entry = zip.file(path);
    return entry ? entry.async('string') : null;
  };

  const containerText = await read('META-INF/container.xml');
  const container = containerText && parseXML(containerText);
  const rootfile = container && byLocalName(container, 'rootfile')[0];
  const opfPath = rootfile && resolvePath(rootfile.getAttribute('full-path') || '', '').path;
  const opfText = opfPath && await read(opfPath);
  const opf = opfText && parseXML(opfText);
  if (!opf) throw new NotABookError("This EPUB is missing its contents list, so it can't be read.");
  const opfDir = dirOf(opfPath);

  const metadata = byLocalName(opf, 'metadata')[0];
  const title = metadata ? squash((childrenNamed(metadata, 'title')[0] || {}).textContent) : '';
  const author = metadata ? childrenNamed(metadata, 'creator').map((n) => squash(n.textContent)).filter(Boolean).join(', ') : '';

  const items = new Map();
  const itemList = [];
  for (const node of byLocalName(opf, 'item')) {
    const id = node.getAttribute('id');
    const href = node.getAttribute('href');
    if (!id || !href) continue;
    const item = { id, path: resolvePath(href, opfDir).path, type: node.getAttribute('media-type') || '',
      properties: (node.getAttribute('properties') || '').split(/\s+/) };
    items.set(id, item);
    itemList.push(item);
  }

  const spineNode = byLocalName(opf, 'spine')[0];
  const refs = spineNode ? childrenNamed(spineNode, 'itemref') : [];
  const pick = (skipHidden) => refs
    .filter((ref) => !(skipHidden && ref.getAttribute('linear') === 'no'))
    .map((ref) => items.get(ref.getAttribute('idref')))
    .filter((item) => item && zip.file(item.path))
    .map((item) => item.path);
  let spine = pick(true);
  if (!spine.length) spine = pick(false);
  if (!spine.length) throw new NotABookError('This EPUB has no chapters in it.');

  const indexOfPath = new Map();
  spine.forEach((path, index) => { if (!indexOfPath.has(path)) indexOfPath.set(path, index); });

  // Contents list: EPUB 3 "nav" file first, older "ncx" file second.
  let toc = [];
  const navItem = itemList.find((item) => item.properties.includes('nav'));
  if (navItem) {
    const navDoc = parseXHTML(await read(navItem.path) || '');
    if (navDoc) toc = readNav(navDoc, navItem.path, indexOfPath);
  }
  if (!toc.length) {
    const tocId = spineNode && spineNode.getAttribute('toc');
    const ncxItem = (tocId && items.get(tocId)) || itemList.find((item) => item.type === 'application/x-dtbncx+xml');
    if (ncxItem) {
      const ncx = parseXML(await read(ncxItem.path) || '');
      if (ncx) toc = readNCX(ncx, ncxItem.path, indexOfPath);
    }
  }
  if (!toc.length) toc = spine.map((path, index) => ({ title: `Section ${index + 1}`, index, fragment: null, level: 0 }));

  let coverPath = (itemList.find((item) => item.properties.includes('cover-image')) || {}).path;
  if (!coverPath && metadata) {
    const meta = childrenNamed(metadata, 'meta').find((m) => m.getAttribute('name') === 'cover');
    const item = meta && items.get(meta.getAttribute('content'));
    if (item && item.type.startsWith('image/')) coverPath = item.path;
  }
  if (!coverPath) {
    coverPath = (itemList.find((item) => item.type.startsWith('image/') && item.id.toLowerCase().includes('cover')) || {}).path;
  }
  if (coverPath && !zip.file(coverPath)) coverPath = null;

  const types = new Map(itemList.map((item) => [item.path, item.type]));
  return { zip, title, author, spine, toc, coverPath: coverPath || null, indexOfPath, types };
}

function readNav(doc, navPath, indexOfPath) {
  const navs = byLocalName(doc, 'nav');
  const tocNav = navs.find((nav) => [...nav.attributes].some((a) => a.localName === 'type' && a.value.includes('toc'))) || navs[0];
  const list = tocNav && byLocalName(tocNav, 'ol')[0];
  if (!list) return [];
  const entries = [];
  const base = dirOf(navPath);
  const walk = (ol, level) => {
    for (const li of childrenNamed(ol, 'li')) {
      let link = childrenNamed(li, 'a')[0];
      if (!link) {
        for (const child of li.children) {
          if (child.localName === 'ol') continue;
          link = byLocalName(child, 'a')[0];
          if (link) break;
        }
      }
      const href = link && link.getAttribute('href');
      if (href) {
        const target = resolvePath(href, base);
        const index = indexOfPath.get(target.path || navPath);
        const title = squash(link.textContent);
        if (index !== undefined && title) entries.push({ title, index, fragment: target.fragment, level });
      }
      for (const nested of childrenNamed(li, 'ol')) walk(nested, level + 1);
    }
  };
  walk(list, 0);
  return entries;
}

function readNCX(doc, ncxPath, indexOfPath) {
  const navMap = byLocalName(doc, 'navMap')[0];
  if (!navMap) return [];
  const entries = [];
  const base = dirOf(ncxPath);
  const walk = (parent, level) => {
    for (const point of childrenNamed(parent, 'navPoint')) {
      const label = childrenNamed(point, 'navLabel')[0];
      const content = childrenNamed(point, 'content')[0];
      const src = content && content.getAttribute('src');
      const title = squash(label && label.textContent);
      if (src) {
        const target = resolvePath(src, base);
        const index = indexOfPath.get(target.path);
        if (index !== undefined && title) entries.push({ title, index, fragment: target.fragment, level });
      }
      walk(point, level + 1);
    }
  };
  walk(navMap, 0);
  return entries;
}

/** The cover picture as a Blob, or null. */
export async function coverBlob(book) {
  if (!book.coverPath) return null;
  const data = await book.zip.file(book.coverPath).async('uint8array');
  if (data.length < 100) return null;
  let type = 'image/jpeg';
  if (data[0] === 0x89 && data[1] === 0x50) type = 'image/png';
  else if (data[0] === 0x47 && data[1] === 0x49) type = 'image/gif';
  else if (data[0] === 0x3C) type = 'image/svg+xml';
  return new Blob([data], { type });
}

const MIME_BY_EXTENSION = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp' };

/**
 * Prepares one chapter for display: returns a complete HTML page (as text) with the book's pictures
 * and styles built in, scripts removed, and links marked so the reader can follow them.
 * `urls` collects the temporary picture addresses so they can be released later.
 */
export async function chapterHTML(book, index, readerCSS, urls) {
  const path = book.spine[index];
  const base = dirOf(path);
  const source = await book.zip.file(path).async('string');
  let doc = parseXHTML(source);
  let body = doc && byLocalName(doc, 'body')[0];
  if (!body) {
    doc = new DOMParser().parseFromString(source, 'text/html');
    body = doc.body;
  }

  const blobURL = async (href) => {
    const target = resolvePath(href, base).path;
    const entry = target && book.zip.file(target);
    if (!entry) return null;
    const extension = target.split('.').pop().toLowerCase();
    const type = book.types.get(target) || MIME_BY_EXTENSION[extension] || 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([await entry.async('uint8array')], { type }));
    urls.push(url);
    return url;
  };

  // The book's own style sheets, with anything they try to load from elsewhere removed.
  let bookCSS = '';
  for (const link of byLocalName(doc, 'link')) {
    if ((link.getAttribute('rel') || '').toLowerCase().includes('stylesheet') && link.getAttribute('href')) {
      const target = resolvePath(link.getAttribute('href'), base).path;
      const entry = book.zip.file(target);
      if (entry) bookCSS += '\n' + await entry.async('string');
    }
  }
  for (const style of byLocalName(doc, 'style')) bookCSS += '\n' + style.textContent;
  bookCSS = bookCSS.replace(/@import[^;]+;/g, '').replace(/@font-face\s*\{[^}]*\}/g, '').replace(/url\([^)]*\)/g, 'none');

  // Move the chapter into an ordinary web page so it is written out the way browsers expect.
  const page = document.implementation.createHTMLDocument('');
  for (const node of [...body.childNodes]) page.body.appendChild(page.importNode(node, true));
  if (body.getAttribute('class')) page.body.setAttribute('class', body.getAttribute('class'));

  for (const el of [...page.body.querySelectorAll('script, iframe, object, embed, form, link, meta, base')]) el.remove();
  for (const el of page.body.querySelectorAll('*')) {
    for (const attribute of [...el.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on')) el.removeAttribute(attribute.name);
    }
  }
  for (const img of page.body.querySelectorAll('img')) {
    const url = img.getAttribute('src') && await blobURL(img.getAttribute('src'));
    img.removeAttribute('srcset');
    if (url) img.setAttribute('src', url); else img.removeAttribute('src');
  }
  for (const image of page.body.querySelectorAll('image')) {
    const href = image.getAttribute('xlink:href') || image.getAttribute('href');
    const url = href && await blobURL(href);
    if (url) { image.setAttribute('href', url); image.removeAttribute('xlink:href'); }
  }
  for (const link of page.body.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      if (/^https?:/i.test(href)) { link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener'); }
      else link.removeAttribute('href');
      continue;
    }
    const target = resolvePath(href, base);
    link.setAttribute('data-bn-path', target.path || path);
    link.setAttribute('data-bn-fragment', target.fragment || '');
    link.setAttribute('href', '#');
  }

  const bodyClass = page.body.getAttribute('class') ? ` class="${escapeXML(page.body.getAttribute('class'))}"` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<style>${bookCSS.replace(/<\/style/gi, '')}</style><style>${readerCSS}</style></head>`
    + `<body${bodyClass}>${page.body.innerHTML}</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Writing EPUBs

/**
 * Builds a standard EPUB 3 file. Give either `chapters` ([{ title, paragraphs }]) for a book of words,
 * or `imagePages` ([Blob, …] of JPEG pictures) for a picture book. Returns a Blob.
 */
export async function buildEpub({ title, author = '', language = 'en', chapters = [], imagePages = [], cover = null }) {
  const zip = new (zipLib())();
  const safeTitle = title || 'Untitled';
  const bookId = 'urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });   // must be first and uncompressed
  const oebps = zip.folder('OEBPS');
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`);
  oebps.file('style.css', `body { font-family: Georgia, serif; line-height: 1.5; margin: 5%; }
h1, h2 { text-align: center; line-height: 1.2; }
h1 { margin-top: 30%; }
h2 { margin: 2em 0 1.5em 0; }
p { margin: 0; text-indent: 1.4em; text-align: left; }
h2 + p { text-indent: 0; }
p.author { text-align: center; text-indent: 0; margin-top: 2em; font-style: italic; }
div.picture { text-align: center; margin: 0; }
div.picture img { max-width: 100%; }
`);

  const page = (pageTitle, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}" xml:lang="${language}">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXML(pageTitle)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>
`;

  const manifest = [];
  const spine = [];
  const nav = [];

  if (cover) {
    oebps.file('cover.jpg', cover);
    manifest.push('<item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
    oebps.file('cover.xhtml', page(safeTitle, '<div class="picture"><img src="cover.jpg" alt="Cover"/></div>'));
    manifest.push('<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('<itemref idref="cover"/>');
  }

  oebps.file('title.xhtml', page(safeTitle,
    `<h1>${escapeXML(safeTitle)}</h1>` + (author ? `\n<p class="author">${escapeXML(author)}</p>` : '')));
  manifest.push('<item id="titlepage" href="title.xhtml" media-type="application/xhtml+xml"/>');
  spine.push('<itemref idref="titlepage"/>');
  nav.push({ title: safeTitle, file: 'title.xhtml' });

  chapters.forEach((chapter, index) => {
    const number = String(index + 1).padStart(3, '0');
    const file = `chapter-${number}.xhtml`;
    const chapterTitle = chapter.title || `Section ${index + 1}`;
    const body = `<h2>${escapeXML(chapterTitle)}</h2>`
      + chapter.paragraphs.filter(Boolean).map((p) => `\n<p>${escapeXML(p)}</p>`).join('');
    oebps.file(file, page(chapterTitle, body));
    manifest.push(`<item id="ch${number}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${number}"/>`);
    nav.push({ title: chapterTitle, file });
  });

  imagePages.forEach((blob, index) => {
    const number = String(index + 1).padStart(3, '0');
    oebps.file(`images/page-${number}.jpg`, blob);
    manifest.push(`<item id="img${number}" href="images/page-${number}.jpg" media-type="image/jpeg"/>`);
    const file = `page-${number}.xhtml`;
    oebps.file(file, page(`Page ${index + 1}`, `<div class="picture"><img src="images/page-${number}.jpg" alt="Page ${index + 1}"/></div>`));
    manifest.push(`<item id="pg${number}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="pg${number}"/>`);
    nav.push({ title: `Page ${index + 1}`, file });
  });

  oebps.file('nav.xhtml', page('Contents', `<nav epub:type="toc" id="toc">
  <h2>Contents</h2>
  <ol>
${nav.map((n) => `    <li><a href="${n.file}">${escapeXML(n.title)}</a></li>`).join('\n')}
  </ol>
</nav>`));

  oebps.file('toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${bookId}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXML(safeTitle)}</text></docTitle>
  <navMap>
${nav.map((n, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXML(n.title)}</text></navLabel>
      <content src="${n.file}"/>
    </navPoint>`).join('\n')}
  </navMap>
</ncx>
`);

  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  oebps.file('content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${language}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${bookId}</dc:identifier>
    <dc:title>${escapeXML(safeTitle)}</dc:title>${author ? `\n    <dc:creator>${escapeXML(author)}</dc:creator>` : ''}
    <dc:language>${language}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>${cover ? '\n    <meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    ${manifest.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spine.join('\n    ')}
  </spine>
</package>
`);

  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}
