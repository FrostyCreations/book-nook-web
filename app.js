import { store, newId, keepStorage } from './core/store.js';
import { SOURCES, MOODS, libraryFetch, sniffFormat } from './core/sources.js';
import { openEpub, coverBlob, chapterHTML, buildEpub } from './core/epub.js';
import { pageText, assemble } from './core/scantext.js';
import { readPage, SCAN_LANGUAGES } from './core/ocr.js';
import { LINK_GROUPS } from './core/links.js';

// ------------------------------------------------------------------------------------------
// Small helpers

const $ = (selector, root = document) => root.querySelector(selector);

/** Builds an element: h('button', { class: 'btn', onclick: fn }, 'Text', childElement) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

let toastTimer = null;
function toast(message, seconds = 4) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, seconds * 1000);
}

function busy(message) {
  $('#busy-text').textContent = message || '';
  $('#busy').hidden = !message;
}

function sheet(title, buttons) {
  const holder = $('#sheet');
  const close = () => { holder.hidden = true; holder.replaceChildren(); };
  holder.replaceChildren(h('div', { class: 'box', role: 'dialog', 'aria-label': title },
    h('h3', {}, title),
    buttons.map((b) => h('button', { class: `btn wide ${b.kind || ''}`, onclick: () => { close(); b.run(); } }, b.label)),
    h('button', { class: 'btn wide quiet', onclick: close }, 'Cancel')));
  holder.hidden = false;
  holder.onclick = (event) => { if (event.target === holder) close(); };
}

/** Shows these elements as the current screen (empty slots are skipped). */
function setView(...nodes) {
  $('#view').replaceChildren(...nodes.flat().filter((node) => node !== null && node !== undefined && node !== false));
}

const explain = (error) => (error && error.message) || 'Something went wrong.';
const settings = {
  get(key, fallback) {
    try { const raw = localStorage.getItem('booknook.' + key); return raw === null ? fallback : JSON.parse(raw); } catch (error) { return fallback; }
  },
  set(key, value) { try { localStorage.setItem('booknook.' + key, JSON.stringify(value)); } catch (error) { /* private mode */ } }
};

// Picture addresses made for the current screen; released when the screen changes.
let screenURLs = [];
const pictureURL = (blob) => { const url = URL.createObjectURL(blob); screenURLs.push(url); return url; };
const releasePictures = () => { screenURLs.forEach((url) => URL.revokeObjectURL(url)); screenURLs = []; };

async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

/** Redraws a picture no bigger than `longest` pixels on its long side, as a JPEG. Returns [{ blob, width, height }]. */
async function prepareImage(blob, longest, { split = false, quality = 0.85 } = {}) {
  const img = await loadImage(blob);
  const scale = Math.min(1, longest / Math.max(img.naturalWidth, img.naturalHeight));
  const fullW = Math.max(1, Math.round(img.naturalWidth * scale));
  const fullH = Math.max(1, Math.round(img.naturalHeight * scale));
  const pieces = split ? [[0, Math.floor(fullW / 2)], [Math.floor(fullW / 2), fullW - Math.floor(fullW / 2)]] : [[0, fullW]];
  const out = [];
  for (const [left, width] of pieces) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = fullH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, fullH);
    ctx.drawImage(img, -left, 0, fullW, fullH);
    const made = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    canvas.width = 0;
    if (made) out.push({ blob: made, width, height: fullH });
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// The shelf (books on this iPad)

const COVER_COLOURS = ['#4F5BA6', '#2F7F7B', '#8A5A3C', '#B0496B', '#3C78B5', '#4E8A4A', '#7A4FA3', '#C8551F'];

async function addBook(blob, { title = '', author = '', source = 'Added', coverURL = null, fileName = '' } = {}) {
  const format = await sniffFormat(blob);
  if (!format) throw new Error("That file isn't an EPUB or PDF, so it can't be added.");
  const book = { id: newId(), title: title.trim(), author: author.trim(), format, source, added: Date.now(),
    lastOpened: null, position: 0, fraction: 0, progress: 0, cover: null };
  let cover = null;

  if (format === 'epub') {
    const epub = await openEpub(blob);
    book.title = book.title || epub.title;
    book.author = book.author || epub.author;
    cover = await coverBlob(epub).catch(() => null);
  } else {
    cover = await pdfCover(blob).catch(() => null);
  }
  if (!cover && coverURL) {
    cover = await libraryFetch(coverURL).then((r) => r.blob()).catch(() => null);
    if (cover && !cover.type.startsWith('image/')) cover = null;
  }
  if (cover) {
    book.cover = await prepareImage(cover, 480, { quality: 0.8 }).then((made) => made[0].blob).catch(() => null);
  }
  if (!book.title) book.title = fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';

  await store.put('files', { id: book.id, blob });
  await store.put('books', book);
  return book;
}

async function removeBook(book) {
  await store.remove('books', book.id);
  await store.remove('files', book.id);
}

async function saveCopy(book) {
  const record = await store.get('files', book.id);
  if (!record) return;
  const name = `${book.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'book'}.${book.format}`;
  const file = new File([record.blob], name, { type: book.format === 'epub' ? 'application/epub+zip' : 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: book.title }); return; } catch (error) { if (error.name === 'AbortError') return; }
  }
  const link = h('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(link);
  link.click();
  link.remove();
}

function coverElement(book) {
  if (book.cover) return h('div', { class: 'cover' }, h('img', { src: pictureURL(book.cover), alt: '' }));
  const sum = [...book.title].reduce((total, ch) => (total + ch.codePointAt(0)) % 1000, 0);
  return h('div', { class: 'cover' },
    h('div', { class: 'blank', style: `background:${COVER_COLOURS[sum % COVER_COLOURS.length]}` }, h('b', {}, book.title), book.author && h('i', {}, book.author)));
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
const isAppleTouch = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function showShelf() {
  const books = (await store.all('books')).sort((a, b) => (b.lastOpened || b.added) - (a.lastOpened || a.added));
  const picker = h('input', { type: 'file', accept: '.epub,.pdf,application/epub+zip,application/pdf', multiple: true, hidden: true,
    onchange: async (event) => {
      const files = [...event.target.files];
      event.target.value = '';
      if (!files.length) return;
      busy(files.length === 1 ? 'Adding the book…' : `Adding ${files.length} books…`);
      const failed = [];
      for (const file of files) {
        try { await addBook(file, { fileName: file.name, source: 'Added from Files' }); } catch (error) { failed.push(file.name); }
      }
      busy('');
      if (failed.length) toast(`Couldn't add: ${failed.join(', ')}. Only EPUB and PDF files without copy protection work.`, 7);
      showShelf();
    } });

  const head = h('div', { class: 'head' }, h('h1', {}, 'My Books'),
    h('button', { class: 'btn', onclick: () => picker.click() }, '+ Add a file'), picker);

  const hint = (!isStandalone() && isAppleTouch() && !settings.get('hideInstallHint', false))
    ? h('div', { class: 'notice stack', style: 'margin-bottom:24px' },
      h('p', {}, h('b', {}, 'Put Book Nook on the Home Screen first. '), 'Tap the Share button in Safari, then “Add to Home Screen”. Books added here in Safari do not move across, so add them after that.'),
      h('button', { class: 'btn quiet', onclick: () => { settings.set('hideInstallHint', true); showShelf(); } }, 'Got it'))
    : null;

  if (!books.length) {
    setView(head, hint, h('div', { class: 'empty stack' },
      h('div', { class: 'big', 'aria-hidden': 'true' }, '📚'),
      h('h2', {}, 'Your shelf is empty'),
      h('p', { class: 'sub' }, 'Find a free book in Find Books, photograph one you own in Scan a Book, or tap “Add a file” for an EPUB or PDF you already have.'),
      h('a', { class: 'btn main', href: '#find' }, 'Find a book')));
    return;
  }

  setView(head, hint, h('div', { class: 'shelf' }, books.map((book) => h('div', { class: 'book' },
    h('button', { class: 'book', 'aria-label': `Read ${book.title}`, onclick: () => openReader(book.id) },
      coverElement(book),
      h('div', { class: 't' }, book.title),
      book.author && h('div', { class: 'a' }, book.author),
      book.progress > 0.005 ? h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(Math.min(1, book.progress) * 100)}%` })) : h('span', { class: 'badge' }, 'New')),
    h('button', { class: 'dots', 'aria-label': `Options for ${book.title}`, onclick: () => sheet(book.title, [
      { label: 'Read', kind: 'main', run: () => openReader(book.id) },
      { label: 'Save a copy of the file', run: () => saveCopy(book) },
      { label: 'Remove from this iPad', kind: 'danger', run: async () => { await removeBook(book); toast('Removed.'); showShelf(); } }
    ]) }, '⋯')))));
}

// ------------------------------------------------------------------------------------------
// Find Books

const findState = { words: '', subject: null, groups: [], searched: false, run: 0, busy: new Set(), done: new Set() };
const IDEAS = ['Jane Austen', 'Sherlock Holmes', 'Alice in Wonderland', 'Jock of the Bushveld', 'Fairy tales', 'Agatha Christie', 'Sprokies', 'Anne of Green Gables'];

function switchedOff() { return new Set(settings.get('sourcesOff', [])); }

/** Searches by title or author. With `subject` (a catalogue heading), browses that shelf instead. */
function search(words, subject = null) {
  findState.words = words.trim();
  findState.subject = subject;
  if (!findState.words) return;
  const off = switchedOff();
  // Only some libraries can be browsed by subject; a typed search uses all of them.
  let sources = SOURCES.filter((source) => !off.has(source.id) && (!subject || source.browse));
  if (subject && !sources.length) sources = SOURCES.filter((source) => source.browse);
  const run = ++findState.run;
  findState.searched = true;
  findState.groups = sources.map((source) => ({ id: source.id, name: source.name, blurb: source.blurb, state: 'loading', results: [], problem: '' }));
  sources.forEach(async (source) => {
    const group = findState.groups.find((g) => g.id === source.id);
    try {
      group.results = await source.search(findState.words, { subject });
      group.state = 'done';
    } catch (error) {
      group.state = 'failed';
      group.problem = explain(error);
    }
    if (run === findState.run && currentTab() === 'find') drawResults();
  });
  showFind();
}

async function download(result, option) {
  if (findState.busy.has(option.url)) return;
  findState.busy.add(option.url);
  drawResults();
  try {
    const response = await libraryFetch(option.url);
    const blob = await response.blob();
    if (!(await sniffFormat(blob))) throw new Error('The download was not an EPUB or PDF. Try “Website” to open the book on the library’s own page.');
    const book = await addBook(blob, { title: result.title, author: result.author, source: result.source, coverURL: result.cover });
    findState.done.add(option.url);
    toast(`“${book.title}” is on your shelf.`);
  } catch (error) {
    toast(`“${result.title}” couldn't be added. ${explain(error)}`, 7);
  }
  findState.busy.delete(option.url);
  if (currentTab() === 'find') drawResults();
}

function resultRow(result) {
  const thumb = h('div', { class: 'thumb', 'aria-hidden': 'true' }, '📖');
  if (result.cover) {
    const img = h('img', { src: result.cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.onload = () => thumb.replaceChildren(img);
  }
  return h('div', { class: 'result' }, thumb, h('div', { class: 'info' },
    h('b', {}, result.title),
    result.author && h('div', { class: 'sub' }, result.author),
    result.detail && h('div', { class: 'sub small' }, result.detail),
    h('div', { class: 'actions' },
      result.downloads.map((option) => {
        if (findState.done.has(option.url)) return h('span', { class: 'btn done' }, '✓ On the shelf');
        if (findState.busy.has(option.url)) return h('span', { class: 'btn quiet' }, h('span', { class: 'spinner mini' }), 'Getting…');
        return h('button', { class: 'btn main', onclick: () => download(result, option) }, `↓ ${option.label}`);
      }),
      result.web && h('a', { class: 'btn', href: result.web, target: '_blank', rel: 'noopener' }, result.downloads.length ? 'Website' : 'Open'))));
}

function drawResults() {
  const holder = $('#results');
  if (!holder) return;
  const hideEmpty = settings.get('hideEmpty', true);
  const section = (group) => h('section', { class: 'group' },
    h('h2', {}, group.name, h('small', {}, group.blurb)),
    group.state === 'loading' ? h('div', { class: 'waiting' }, h('span', { class: 'spinner mini' }), 'Searching…')
      : group.state === 'failed' ? h('p', { class: 'sub', style: 'padding:14px 0' }, group.problem)
        : group.results.length ? group.results.map(resultRow) : h('p', { class: 'sub', style: 'padding:14px 0' }, 'Nothing found here.'));

  const withBooks = findState.groups.filter((group) => group.state === 'done' && group.results.length);
  const waiting = findState.groups.filter((group) => group.state === 'loading');
  const nothing = findState.groups.filter((group) => group.state === 'failed' || (group.state === 'done' && !group.results.length));
  const shown = hideEmpty ? [...withBooks, ...waiting] : findState.groups;

  const filter = h('label', { class: 'row', style: 'border-top:0;justify-content:flex-start;gap:12px;margin-top:18px' },
    h('input', { type: 'checkbox', checked: hideEmpty, onchange: (event) => { settings.set('hideEmpty', event.target.checked); drawResults(); } }),
    'Only show libraries that found something');

  let summary = null;
  if (hideEmpty && nothing.length) {
    const names = nothing.map((group) => group.name).join(', ');
    summary = h('p', { class: 'sub small', style: 'margin-top:26px' },
      !withBooks.length && !waiting.length ? 'None of the libraries found anything for that. ' : '',
      `Nothing from: ${names}.`);
  }
  holder.replaceChildren(filter, ...shown.map(section), ...(summary ? [summary] : []));
}

function showFind() {
  const off = switchedOff();
  const input = h('input', { class: 'field', type: 'search', placeholder: 'Title or author', value: findState.words, 'aria-label': 'Search for a book', enterkeyhint: 'search' });
  const form = h('form', { class: 'search', onsubmit: (event) => { event.preventDefault(); input.blur(); search(input.value); } },
    input, h('button', { class: 'btn main', type: 'submit' }, 'Search'));
  const chips = h('div', { class: 'chips' }, SOURCES.map((source) => h('button', {
    class: `chip ${off.has(source.id) ? '' : 'on'}`, 'aria-pressed': off.has(source.id) ? 'false' : 'true', title: source.blurb,
    onclick: () => {
      const now = switchedOff();
      if (now.has(source.id)) now.delete(source.id); else now.add(source.id);
      settings.set('sourcesOff', [...now]);
      showFind();
    } }, source.name)));

  const body = findState.searched
    ? h('div', {},
      h('button', { class: 'btn quiet', style: 'margin-top:18px', onclick: () => { findState.searched = false; findState.words = ''; findState.subject = null; findState.run += 1; showFind(); } }, '‹ Shelves and ideas'),
      h('div', { id: 'results' }))
    : h('div', { class: 'stack', style: 'margin-top:26px' },
      h('p', { class: 'sub' }, 'Everything here is free and legal to keep: older books whose copyright has run out, and newer ones their authors chose to share. Brand-new bestsellers will not be here.'),
      h('h3', {}, 'Browse a shelf'),
      h('div', { class: 'chips' }, MOODS.map((mood) => h('button', { class: 'chip', onclick: () => search(mood.label, mood.subject) }, mood.label))),
      h('h3', {}, 'Or try a search'),
      h('div', { class: 'chips' }, IDEAS.map((idea) => h('button', { class: 'chip', onclick: () => search(idea) }, idea))));

  setView(
    h('div', { class: 'head' }, h('h1', {}, 'Find Books')),
    form,
    h('p', { class: 'sub small', style: 'margin:16px 0 8px' }, 'Libraries to search (tap to switch on or off)'),
    chips, body);
  drawResults();
}

// ------------------------------------------------------------------------------------------
// Scan a Book

async function scanPages(scan) {
  const all = await store.byIndex('pages', 'scanId', scan.id);
  const byId = new Map(all.map((page) => [page.id, page]));
  return scan.pageIds.map((id) => byId.get(id)).filter(Boolean);
}

async function showScanList() {
  const scans = (await store.all('scans')).sort((a, b) => b.created - a.created);
  const start = async () => {
    const scan = { id: newId(), title: '', author: '', kind: 'words', language: 'eng', twoPages: false, firstIsCover: true, pageIds: [], created: Date.now() };
    await store.put('scans', scan);
    location.hash = `#scan/${scan.id}`;
  };
  setView(
    h('div', { class: 'head' }, h('h1', {}, 'Scan a Book')),
    h('div', { class: 'card stack' },
      h('h2', {}, 'Turn a paper book into an ebook'),
      h('p', { class: 'sub' }, 'Photograph the pages of a book you own. The words are read on this iPad (nothing is sent anywhere) and become an ebook on your shelf.'),
      h('button', { class: 'btn main', onclick: start }, '+ Start a new book')),
    scans.length ? h('div', { class: 'card list', style: 'margin-top:22px' }, h('h3', { style: 'margin-bottom:6px' }, 'Books in progress'),
      scans.map((scan) => h('a', { href: `#scan/${scan.id}` },
        h('span', {}, h('b', {}, scan.title || 'Untitled book'), h('span', { class: 'sub small' }, scan.pageIds.length === 1 ? '1 page' : `${scan.pageIds.length} pages`)),
        h('span', { 'aria-hidden': 'true' }, '›')))) : null,
    h('div', { class: 'card stack', style: 'margin-top:22px' },
      h('h3', {}, 'Tips for good scans'),
      h('p', { class: 'sub' }, '☀️ Bright, even light. Near a window is perfect.'),
      h('p', { class: 'sub' }, '📄 One page per photo, held flat, filling the frame, the right way up.'),
      h('p', { class: 'sub' }, '⏳ A whole novel is a few hundred photos. Do a chapter at a time; your pages are kept.'),
      h('p', { class: 'sub' }, '✋ Scan books you own, for your own reading.')));
}

let editingPages = false;

async function showScan(scanId) {
  const scan = await store.get('scans', scanId);
  if (!scan) { location.hash = '#scan'; return; }
  const pages = await scanPages(scan);
  const needsReading = (list) => {
    const skipCover = scan.kind === 'words' && scan.firstIsCover && list.length > 1;
    return list.filter((page, index) => !(skipCover && index === 0) && (page.text === null || page.text === undefined));
  };
  const unread = needsReading(pages).length;
  const save = async (changes) => { Object.assign(scan, changes); await store.put('scans', scan); };

  const addPhotos = async (files) => {
    if (!files.length) return;
    busy('Saving pages…');
    try {
      for (const file of files) {
        const made = await prepareImage(file, 2400, { split: scan.twoPages });
        for (const piece of made) {
          const thumb = (await prepareImage(piece.blob, 260, { quality: 0.7 }))[0].blob;
          const page = { id: newId(), scanId: scan.id, blob: piece.blob, thumb, width: piece.width, height: piece.height, text: null };
          await store.put('pages', page);
          scan.pageIds.push(page.id);
        }
      }
      await store.put('scans', scan);
    } catch (error) {
      toast("One of the photos couldn't be saved. " + explain(error), 6);
    }
    busy('');
    showScan(scanId);
  };
  const photoInput = (capture) => h('input', { type: 'file', accept: 'image/*', multiple: !capture, capture: capture ? 'environment' : null, hidden: true,
    onchange: (event) => { const files = [...event.target.files]; event.target.value = ''; addPhotos(files); } });
  const camera = photoInput(true);
  const library = photoInput(false);

  const readAll = async () => {
    const waiting = needsReading(await scanPages(scan));
    for (let i = 0; i < waiting.length; i += 1) {
      const label = waiting.length === 1 ? 'Reading the page…' : `Reading page ${i + 1} of ${waiting.length}…`;
      busy(label);
      const lines = await readPage(waiting[i].blob, waiting[i].width, waiting[i].height, scan.language,
        (progress) => busy(`${label} ${Math.round(progress * 100)}%`));
      waiting[i].text = pageText(lines);
      await store.put('pages', waiting[i]);
    }
  };

  const makeBook = async () => {
    try {
      const title = scan.title.trim() || 'Scanned book';
      let book;
      if (scan.kind === 'words') {
        await readAll();
        busy('Putting the book together…');
        const fresh = await scanPages(scan);
        const useCover = scan.firstIsCover && fresh.length > 1;
        const chapters = assemble((useCover ? fresh.slice(1) : fresh).map((page) => page.text || ''), title);
        if (!chapters.some((chapter) => chapter.paragraphs.length)) {
          throw new Error('No words could be read from these photos. If it is a picture book, switch to “Mostly pictures”.');
        }
        const code = (SCAN_LANGUAGES.find((l) => l.id === scan.language) || {}).code || 'en';
        const epub = await buildEpub({ title, author: scan.author.trim(), language: code, chapters, cover: useCover ? fresh[0].blob : null });
        book = await addBook(epub, { title, author: scan.author.trim(), source: 'Scanned' });
      } else {
        busy('Putting the book together…');
        const fresh = await scanPages(scan);
        const epub = await buildEpub({ title, author: scan.author.trim(), imagePages: fresh.map((page) => page.blob), cover: fresh[0].blob });
        book = await addBook(epub, { title, author: scan.author.trim(), source: 'Scanned' });
      }
      busy('');
      toast(`“${book.title}” is now in My Books.`, 6);
      showScan(scanId);
    } catch (error) {
      busy('');
      toast(explain(error), 7);
      showScan(scanId);
    }
  };

  const movePage = async (index, by) => {
    const target = index + by;
    if (target < 0 || target >= scan.pageIds.length) return;
    const ids = scan.pageIds;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await store.put('scans', scan);
    showScan(scanId);
  };
  const deletePage = async (page) => {
    scan.pageIds = scan.pageIds.filter((id) => id !== page.id);
    await store.put('scans', scan);
    await store.remove('pages', page.id);
    showScan(scanId);
  };

  const text = (key, placeholder) => h('input', { class: 'field', type: 'text', placeholder, value: scan[key], oninput: (event) => save({ [key]: event.target.value }) });
  const toggle = (key, label) => h('label', { class: 'row' }, label,
    h('input', { type: 'checkbox', checked: scan[key], onchange: (event) => save({ [key]: event.target.checked }) }));

  releasePictures();
  setView(
    h('a', { class: 'back', href: '#scan' }, '‹ All scans'),
    h('div', { class: 'head' }, h('h1', {}, scan.title || 'New book')),
    h('div', { class: 'card' },
      h('div', { class: 'stack', style: 'margin-bottom:8px' }, text('title', 'Title'), text('author', 'Author')),
      h('label', { class: 'row' }, 'What’s inside',
        h('select', { class: 'field', onchange: async (event) => { await save({ kind: event.target.value }); showScan(scanId); } },
          h('option', { value: 'words', selected: scan.kind === 'words' }, 'Mostly words (novels, non-fiction)'),
          h('option', { value: 'pictures', selected: scan.kind === 'pictures' }, 'Mostly pictures (picture books, comics)'))),
      scan.kind === 'words' && h('label', { class: 'row' }, 'Language',
        h('select', { class: 'field', onchange: (event) => save({ language: event.target.value }) },
          SCAN_LANGUAGES.map((l) => h('option', { value: l.id, selected: scan.language === l.id }, l.label)))),
      scan.kind === 'words' && toggle('firstIsCover', 'The first photo is the cover'),
      toggle('twoPages', 'Each photo shows two pages')),

    h('div', { class: 'card stack', style: 'margin-top:22px' },
      h('h2', {}, 'Add pages'),
      h('div', { class: 'chips' },
        h('button', { class: 'btn main', onclick: () => camera.click() }, '📷 Take a photo'),
        h('button', { class: 'btn', onclick: () => library.click() }, 'Choose photos'), camera, library),
      h('p', { class: 'sub small' }, '“Take a photo” opens the camera for one page at a time. For lots of pages it is quicker to photograph them all with the Camera app first, then use “Choose photos” and select them in order.')),

    pages.length ? h('div', { class: 'card stack', style: 'margin-top:22px' },
      h('div', { class: 'head', style: 'margin-bottom:0' },
        h('h2', {}, pages.length === 1 ? '1 page' : `${pages.length} pages`),
        h('button', { class: 'btn quiet', onclick: () => { editingPages = !editingPages; showScan(scanId); } }, editingPages ? 'Done' : 'Reorder or remove')),
      h('div', { class: 'pages' }, pages.map((page, index) => {
        const isCover = scan.kind === 'words' && index === 0 && scan.firstIsCover && pages.length > 1;
        const read = page.text !== null && page.text !== undefined;
        return h('div', { class: 'page' },
          h('a', { href: `#scan/${scan.id}/${page.id}`, 'aria-label': `Page ${index + 1}` },
            h('div', { class: 'shot' }, h('img', { src: pictureURL(page.thumb), alt: '' }))),
          h('div', { class: 'n' }, isCover ? 'Cover' : `Page ${index + 1}`),
          scan.kind === 'words' && !isCover && h('div', { class: `s ${read ? '' : 'todo'}` }, read ? (page.text ? 'Read ✓' : 'No words found') : 'Not read yet'),
          editingPages && h('div', { class: 'tools' },
            h('button', { 'aria-label': 'Move earlier', disabled: index === 0, onclick: () => movePage(index, -1) }, '←'),
            h('button', { 'aria-label': 'Move later', disabled: index === pages.length - 1, onclick: () => movePage(index, 1) }, '→'),
            h('button', { 'aria-label': 'Remove page', onclick: () => deletePage(page) }, '✕')));
      })),
      h('p', { class: 'sub small' }, 'Tap a page to check or fix its words.')) : null,

    pages.length ? h('div', { class: 'card stack', style: 'margin-top:22px' },
      scan.kind === 'words' && unread > 0 && h('button', { class: 'btn wide', onclick: async () => {
        try { await readAll(); } catch (error) { toast(explain(error), 6); }
        busy('');
        showScan(scanId);
      } }, `Read the words on ${unread} new page${unread === 1 ? '' : 's'}`),
      h('button', { class: 'btn main wide', onclick: makeBook }, 'Make the ebook'),
      h('p', { class: 'sub small' }, 'You can make the ebook now and again later after adding more pages. Each time adds a fresh copy to My Books.')) : null,

    h('button', { class: 'btn danger quiet', style: 'margin-top:26px', onclick: () => sheet('Delete this scan and its photos?', [
      { label: 'Delete', kind: 'danger', run: async () => {
        for (const id of scan.pageIds) await store.remove('pages', id);
        await store.remove('scans', scan.id);
        location.hash = '#scan';
      } }]) }, 'Delete this scan'));
}

async function showScanPage(scanId, pageId) {
  const scan = await store.get('scans', scanId);
  const page = await store.get('pages', pageId);
  if (!scan || !page) { location.hash = `#scan/${scanId}`; return; }
  const number = scan.pageIds.indexOf(pageId) + 1;
  let saveTimer = null;
  const area = h('textarea', { class: 'field', 'aria-label': 'Words on this page', oninput: () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => { page.text = area.value; await store.put('pages', page); }, 500);
  } });
  area.value = page.text || '';
  const again = async () => {
    try {
      busy('Reading the page…');
      const lines = await readPage(page.blob, page.width, page.height, scan.language, (p) => busy(`Reading the page… ${Math.round(p * 100)}%`));
      page.text = pageText(lines);
      await store.put('pages', page);
      area.value = page.text;
    } catch (error) { toast(explain(error), 6); }
    busy('');
  };
  releasePictures();
  setView(
    h('a', { class: 'back', href: `#scan/${scanId}` }, `‹ ${scan.title || 'Back to the book'}`),
    h('div', { class: 'head' }, h('h1', {}, `Page ${number}`),
      scan.kind === 'words' && h('button', { class: 'btn', onclick: again }, page.text === null ? 'Read the words' : 'Read again')),
    h('div', { class: 'split' },
      h('img', { src: pictureURL(page.blob), alt: `Photo of page ${number}` }),
      scan.kind === 'words' && h('div', { class: 'stack' }, area,
        h('p', { class: 'sub small' }, 'Leave an empty line between paragraphs. Start a line with # to mark a chapter heading.'))));
}

// ------------------------------------------------------------------------------------------
// More Libraries

function showMore() {
  setView(
    h('div', { class: 'head' }, h('h1', {}, 'More Libraries')),
    h('p', { class: 'sub', style: 'margin-bottom:22px' }, 'These libraries open as websites. Find a book, download its EPUB or PDF (it saves to the Files app), then come back to My Books and tap “Add a file”.'),
    LINK_GROUPS.map((group) => h('div', { class: 'card list', style: 'margin-bottom:22px' }, h('h3', { style: 'margin-bottom:6px' }, group.title),
      group.links.map(([name, url, blurb]) => h('a', { href: url, target: '_blank', rel: 'noopener' },
        h('span', {}, h('b', {}, name), h('span', { class: 'sub small' }, blurb)), h('span', { 'aria-hidden': 'true' }, '↗'))))));
}

// ------------------------------------------------------------------------------------------
// The reader

const THEMES = {
  light: { label: 'White', bg: '#FFFFFF', ink: '#1C1C1E', link: '#B25000' },
  sepia: { label: 'Sepia', bg: '#F7EFDD', ink: '#46362A', link: '#9A4A00' },
  dark: { label: 'Dark', bg: '#1B1B1D', ink: '#D6D6D8', link: '#FFB066' }
};
const FONTS = {
  original: { label: "Book's own", css: null },
  serif: { label: 'Serif', css: "Georgia, 'Iowan Old Style', 'Times New Roman', serif" },
  sans: { label: 'Sans', css: "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif" }
};

function readerCSS() {
  const theme = THEMES[settings.get('theme', 'sepia')] || THEMES.sepia;
  const font = FONTS[settings.get('font', 'original')] || FONTS.original;
  const size = settings.get('size', 115);
  return `html { font-size: ${size}% !important; background: ${theme.bg} !important; overflow: hidden !important; height: auto !important; -webkit-text-size-adjust: 100% !important; }
body { font-size: 1rem !important; background: ${theme.bg} !important; color: ${theme.ink} !important; height: auto !important; min-height: 0 !important;
  margin: 0 auto !important; padding: 28px 7% 24px 7% !important; max-width: 44em !important; line-height: 1.6 !important; overflow-wrap: break-word; }
p, div, span, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, i, b, em, strong, cite, small, pre, dt, dd, font { color: inherit !important; background-color: transparent !important; }
a, a * { color: ${theme.link} !important; }
img, svg, video { max-width: 100% !important; height: auto !important; }
pre { white-space: pre-wrap !important; }
table { max-width: 100% !important; }
${font.css ? `body, p, div, span, li, blockquote, td, th { font-family: ${font.css} !important; }` : ''}`;
}

let closeCurrentReader = null;

async function openReader(bookId) {
  const book = await store.get('books', bookId);
  const record = await store.get('files', bookId);
  const reader = $('#reader');
  if (!book || !record) { toast('That book is no longer on the shelf.'); return; }
  if (closeCurrentReader) await closeCurrentReader();
  reader.hidden = false;
  $('#app').inert = true;
  book.lastOpened = Date.now();
  await store.put('books', book);

  let saveTimer = null;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.put('books', book), 1000); };
  const cleanups = [];
  const close = async () => {
    clearTimeout(saveTimer);
    await store.put('books', book);
    cleanups.forEach((fn) => { try { fn(); } catch (error) { /* ignore */ } });
    reader.hidden = true;
    reader.replaceChildren();
    $('#app').inert = false;
    closeCurrentReader = null;
    if (currentTab() === 'shelf') showShelf();
  };
  closeCurrentReader = close;

  const applyTheme = () => {
    const theme = THEMES[settings.get('theme', 'sepia')] || THEMES.sepia;
    reader.style.setProperty('--r-bg', theme.bg);
    reader.style.setProperty('--r-ink', theme.ink);
  };
  applyTheme();

  const scroll = h('div', { class: 'scroll' });
  const closeButton = h('button', { class: 'icon', 'aria-label': 'Close the book', onclick: close }, '✕ Close');
  const title = h('b', {}, book.title);
  const top = h('div', { class: 'top' }, closeButton, title);
  const bottom = h('div', { class: 'bottom' });
  reader.replaceChildren(top, scroll, bottom);
  scroll.replaceChildren(h('div', { class: 'message' }, h('div', { class: 'spinner' }), h('p', {}, 'Opening…')));

  try {
    if (book.format === 'pdf') await readPDF({ book, blob: record.blob, scroll, top, bottom, saveSoon, cleanups });
    else await readEPUB({ book, blob: record.blob, scroll, top, bottom, saveSoon, cleanups, applyTheme, reader });
  } catch (error) {
    scroll.replaceChildren(h('div', { class: 'message stack' }, h('h2', {}, 'This book would not open'), h('p', {}, explain(error)),
      h('button', { class: 'btn main', onclick: close }, 'Close')));
  }
}

async function readEPUB({ book, blob, scroll, top, bottom, saveSoon, cleanups, applyTheme, reader }) {
  const epub = await openEpub(blob);
  const count = epub.spine.length;
  let index = Math.min(Math.max(book.position || 0, 0), count - 1);
  let urls = [];
  let panel = null;
  let loadToken = 0;

  const frame = h('iframe', { title: 'Book text', sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox', scrolling: 'no' });
  const previous = h('button', { onclick: () => show(index - 1, 0) }, '‹ Previous');
  const next = h('button', { onclick: () => show(index + 1, 0) }, 'Next ›');
  scroll.replaceChildren(frame, h('div', { class: 'turn' }, previous, next));

  const meterFill = h('i', {});
  const meterText = h('span', {});
  const back = h('button', { class: 'icon', 'aria-label': 'Previous part', onclick: () => show(index - 1, 0) }, '‹');
  const forward = h('button', { class: 'icon', 'aria-label': 'Next part', onclick: () => show(index + 1, 0) }, '›');
  bottom.replaceChildren(back, h('div', { class: 'meter' }, h('div', { class: 'bar' }, meterFill), meterText), forward);

  const fraction = () => {
    const max = scroll.scrollHeight - scroll.clientHeight;
    return max > 4 ? Math.min(1, Math.max(0, scroll.scrollTop / max)) : 1;
  };
  const updateMeter = () => {
    const progress = Math.min(1, (index + (book.fraction || 0)) / count);
    meterFill.style.width = `${Math.round(progress * 100)}%`;
    meterText.textContent = `Part ${index + 1} of ${count}  ·  ${Math.round(progress * 100)}% read`;
    previous.disabled = back.disabled = index <= 0;
    next.disabled = forward.disabled = index >= count - 1;
  };
  const remember = () => {
    book.position = index;
    book.fraction = fraction();
    book.progress = Math.min(1, (index + book.fraction) / count);
    updateMeter();
    saveSoon();
  };

  let scrollTimer = null;
  const onScroll = () => { if (!scrollTimer) scrollTimer = setTimeout(() => { scrollTimer = null; remember(); }, 300); };
  scroll.addEventListener('scroll', onScroll, { passive: true });

  const fit = () => {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    frame.style.height = `${Math.ceil(doc.body.getBoundingClientRect().height) + 2}px`;
  };
  const watcher = new ResizeObserver(fit);

  async function show(target, startFraction = 0, fragment = null) {
    if (target < 0 || target >= count) return;
    const token = ++loadToken;
    index = target;
    closePanel();
    const old = urls;
    urls = [];
    const html = await chapterHTML(epub, index, readerCSS(), urls);
    if (token !== loadToken) return;
    await new Promise((resolve) => {
      frame.onload = resolve;
      frame.srcdoc = html;
    });
    if (token !== loadToken) return;
    old.forEach((url) => URL.revokeObjectURL(url));
    const doc = frame.contentDocument;
    watcher.disconnect();
    watcher.observe(doc.body);
    for (const img of doc.images) if (!img.complete) img.addEventListener('load', fit, { once: true });
    doc.addEventListener('click', (event) => {
      const link = event.target.closest && event.target.closest('a[data-bn-path]');
      if (!link) return;
      event.preventDefault();
      const path = link.getAttribute('data-bn-path');
      const anchor = link.getAttribute('data-bn-fragment') || null;
      const where = epub.indexOfPath.get(path);
      if (where === undefined) return;
      if (where === index) jumpTo(anchor); else show(where, 0, anchor);
    });
    fit();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    fit();
    if (fragment) jumpTo(fragment);
    else scroll.scrollTop = startFraction * Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    book.position = index;
    book.fraction = fragment ? fraction() : startFraction;
    book.progress = Math.min(1, (index + book.fraction) / count);
    updateMeter();
    saveSoon();
  }

  function jumpTo(fragment) {
    const doc = frame.contentDocument;
    if (!fragment || !doc) { scroll.scrollTop = 0; return; }
    const target = doc.getElementById(fragment) || doc.getElementsByName(fragment)[0];
    scroll.scrollTop = target ? Math.max(0, target.getBoundingClientRect().top + frame.offsetTop - 12) : 0;
    remember();
  }

  function restyle() {
    const doc = frame.contentDocument;
    const styles = doc && doc.querySelectorAll('head style');
    if (!styles || !styles.length) return;
    const keep = fraction();
    styles[styles.length - 1].textContent = readerCSS();
    applyTheme();
    fit();
    requestAnimationFrame(() => { fit(); scroll.scrollTop = keep * Math.max(0, scroll.scrollHeight - scroll.clientHeight); });
  }

  function closePanel() { if (panel) { panel.remove(); panel = null; } }
  function openPanel(kind) {
    const same = panel && panel.dataset.kind === kind;
    closePanel();
    if (same) return;
    if (kind === 'contents') {
      panel = h('div', { class: 'panel toc' }, h('h3', {}, 'Contents'), epub.toc.map((entry) => h('button', {
        class: entry.index === index ? 'here' : '', style: `padding-left:${6 + Math.min(entry.level, 4) * 18}px`,
        onclick: () => show(entry.index, 0, entry.fragment) }, entry.title)));
    } else {
      const segment = (key, options, fallback) => h('div', { class: 'seg' }, Object.entries(options).map(([id, option]) => h('button', {
        class: settings.get(key, fallback) === id ? 'on' : '',
        onclick: () => { settings.set(key, id); restyle(); openPanel('settings'); openPanel('settings'); } }, option.label)));
      const size = settings.get('size', 115);
      const resize = (by) => { settings.set('size', Math.min(260, Math.max(70, settings.get('size', 115) + by))); restyle(); openPanel('settings'); openPanel('settings'); };
      panel = h('div', { class: 'panel' },
        h('h3', {}, `Text size (${size}%)`),
        h('div', { class: 'seg' }, h('button', { 'aria-label': 'Smaller text', disabled: size <= 70, onclick: () => resize(-10) }, 'A −'),
          h('button', { 'aria-label': 'Bigger text', disabled: size >= 260, onclick: () => resize(10), style: 'font-size:22px' }, 'A +')),
        h('h3', {}, 'Page colour'), segment('theme', THEMES, 'sepia'),
        h('h3', {}, 'Lettering'), segment('font', FONTS, 'original'));
    }
    panel.dataset.kind = kind;
    reader.append(panel);
  }

  top.append(
    h('button', { class: 'icon', 'aria-label': 'Contents', onclick: () => openPanel('contents') }, '☰'),
    h('button', { class: 'icon', 'aria-label': 'Text size and colours', onclick: () => openPanel('settings') }, 'Aa'));
  scroll.addEventListener('click', closePanel);

  cleanups.push(() => { watcher.disconnect(); urls.forEach((url) => URL.revokeObjectURL(url)); scroll.removeEventListener('scroll', onScroll); });
  await show(index, book.fraction || 0);
}

// --- PDF

let pdfLibrary = null;
async function loadPDFLibrary() {
  if (!pdfLibrary) {
    pdfLibrary = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfLibrary.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', document.baseURI).href;
  }
  return pdfLibrary;
}

async function pdfCover(blob) {
  const pdfjs = await loadPDFLibrary();
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 480 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  } finally {
    doc.destroy();
  }
}

async function readPDF({ book, blob, scroll, bottom, saveSoon, cleanups }) {
  const pdfjs = await loadPDFLibrary();
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const count = doc.numPages;
  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const cssWidth = Math.min(scroll.clientWidth - 16, 1000);
  const ratio = base.height / base.width;
  const density = Math.min(window.devicePixelRatio || 1, 2);

  const label = h('span', { style: 'flex:1;text-align:center' });
  bottom.replaceChildren(label);
  const canvases = [];
  for (let i = 0; i < count; i += 1) {
    const canvas = h('canvas', { class: 'pdf-page', 'data-page': String(i) });
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${Math.round(cssWidth * ratio)}px`;
    canvases.push(canvas);
  }
  scroll.replaceChildren(...canvases);

  const rendering = new Set();
  const drawn = new Set();
  const draw = async (i) => {
    if (drawn.has(i) || rendering.has(i)) return;
    rendering.add(i);
    try {
      const page = await doc.getPage(i + 1);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (cssWidth / natural.width) * density });
      const canvas = canvases[i];
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.style.height = `${Math.round(cssWidth * (natural.height / natural.width))}px`;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      drawn.add(i);
    } catch (error) { /* a page that fails to draw stays blank */ }
    rendering.delete(i);
  };
  const near = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const i = Number(entry.target.dataset.page);
      if (entry.isIntersecting) draw(i);
      else if (drawn.has(i)) { entry.target.width = 0; entry.target.height = 0; drawn.delete(i); }   // free memory for far-away pages
    }
  }, { root: scroll, rootMargin: '150% 0px' });
  canvases.forEach((canvas) => near.observe(canvas));

  const current = () => {
    const middle = scroll.scrollTop + scroll.clientHeight / 2;
    let page = 0;
    for (let i = 0; i < count; i += 1) { if (canvases[i].offsetTop <= middle) page = i; else break; }
    return page;
  };
  const update = () => {
    const page = current();
    label.textContent = `Page ${page + 1} of ${count}`;
    book.position = page;
    book.fraction = 0;
    book.progress = count > 1 ? page / (count - 1) : 1;
    saveSoon();
  };
  let timer = null;
  const onScroll = () => { if (!timer) timer = setTimeout(() => { timer = null; update(); }, 250); };
  scroll.addEventListener('scroll', onScroll, { passive: true });
  cleanups.push(() => { near.disconnect(); scroll.removeEventListener('scroll', onScroll); doc.destroy(); });

  const start = Math.min(Math.max(book.position || 0, 0), count - 1);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  scroll.scrollTop = Math.max(0, canvases[start].offsetTop - 12);
  label.textContent = `Page ${start + 1} of ${count}`;
}

// ------------------------------------------------------------------------------------------
// Moving between screens

function currentTab() {
  return (location.hash.replace(/^#/, '').split('/')[0]) || 'shelf';
}

async function route() {
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  const tab = parts[0] || 'shelf';
  releasePictures();
  for (const link of document.querySelectorAll('#tabs a')) link.classList.toggle('on', link.dataset.tab === tab);
  try {
    if (tab === 'find') showFind();
    else if (tab === 'scan' && parts[2]) await showScanPage(parts[1], parts[2]);
    else if (tab === 'scan' && parts[1]) await showScan(parts[1]);
    else if (tab === 'scan') await showScanList();
    else if (tab === 'more') showMore();
    else await showShelf();
  } catch (error) {
    setView(h('div', { class: 'empty stack' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'sub' }, explain(error))));
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
keepStorage();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Handy for testing from the browser console.
window.bookNook = { store, addBook, openReader, search, buildEpub, openEpub, assemble, pageText, readPage, findState };
