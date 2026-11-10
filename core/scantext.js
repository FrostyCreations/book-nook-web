// Turns the raw lines the text reader finds on a photographed page into tidy paragraphs,
// and stitches many pages into chapters.
// A "line" is { text, x, y, width, height } with positions as fractions of the page, from the top-left.

export const HEADING = '# ';

const SENTENCE_ENDERS = new Set(['.', '!', '?', ':', ';', '"', '”', '’', "'", '…', ')', '»']);
const HYPHENS = new Set(['-', '‐', '‑', '¬', '–']);
const ROMAN = new Set(['i', 'v', 'x', 'l', 'c']);
const NUMBER_WORDS = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  'twenty', 'thirty', 'forty', 'fifty',
  'een', 'twee', 'drie', 'vier', 'vyf', 'ses', 'sewe', 'agt', 'nege', 'tien', 'elf', 'twaalf', 'dertien',
  'veertien', 'vyftien', 'sestien', 'sewentien', 'agtien', 'negentien', 'twintig', 'dertig', 'veertig', 'vyftig',
  'first', 'second', 'third', 'eerste', 'tweede', 'derde']);
const STARTERS = ['chapter ', 'hoofstuk ', 'part ', 'deel ', 'book ', 'boek ', 'prologue', 'epilogue',
  'proloog', 'epiloog', 'introduction', 'inleiding', 'preface', 'voorwoord', 'contents'];

const squash = (text) => text.split(/\s+/).filter(Boolean).join(' ');
const isLetter = (ch) => /\p{L}/u.test(ch);
const isLower = (ch) => ch !== ch.toUpperCase() && ch === ch.toLowerCase();
const median = (values, at = 0.5) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))];
};

export function isPageNumber(text) {
  let t = text.trim().toLowerCase().replace(/^[-–—·•.\[\]() ]+|[-–—·•.\[\]() ]+$/g, '');
  if (t.startsWith('page ')) t = t.slice(5);
  if (t.startsWith('bladsy ')) t = t.slice(7);
  if (!t || t.length > 5) return false;
  if (/^\d+$/.test(t)) return true;
  return t.length <= 4 && [...t].every((ch) => ROMAN.has(ch));
}

export function isChapterHeading(text) {
  if (text.length > 60) return false;
  const lower = text.toLowerCase();
  const starter = STARTERS.find((s) => lower.startsWith(s));
  if (!starter) return false;
  if (!starter.endsWith(' ')) return text.length <= starter.length + 2;   // single words must stand alone
  const first = lower.slice(starter.length).split(' ').filter(Boolean)[0];
  if (!first) return false;
  const word = first.replace(/^[.:,\-–—]+|[.:,\-–—]+$/g, '');
  if (!word) return false;
  if (/^\d+$/.test(word)) return true;
  if ([...word].every((ch) => ROMAN.has(ch))) return true;
  return NUMBER_WORDS.has(word.split('-')[0]);
}

/** Joins running text, mending words split by a hyphen at the end of a line. */
export function join(first, second) {
  if (!first) return second;
  if (!second) return first;
  const chars = [...first];
  if (chars.length >= 2 && HYPHENS.has(chars[chars.length - 1]) && isLetter(chars[chars.length - 2])) {
    const next = [...second][0];
    if (next && isLetter(next) && isLower(next)) return chars.slice(0, -1).join('') + second;
  }
  return first + ' ' + second;
}

/** The text reader sometimes splits one printed line into pieces; put them back together. */
function groupIntoRows(lines) {
  const sorted = lines.filter((l) => l.text && l.text.trim())
    .sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2));
  const groups = [];
  for (const line of sorted) {
    const last = groups[groups.length - 1];
    if (last) {
      const anchor = last[0];
      const distance = Math.abs((line.y + line.height / 2) - (anchor.y + anchor.height / 2));
      if (distance < Math.max(anchor.height, line.height) * 0.5) { last.push(line); continue; }
    }
    groups.push([line]);
  }
  return groups.map((group) => {
    const ordered = group.sort((a, b) => a.x - b.x);
    const minX = Math.min(...ordered.map((l) => l.x));
    const maxX = Math.max(...ordered.map((l) => l.x + l.width));
    return {
      text: ordered.map((l) => l.text).join(' '),
      x: minX,
      y: Math.min(...ordered.map((l) => l.y)),
      width: maxX - minX,
      height: Math.max(...ordered.map((l) => l.height))
    };
  });
}

/** One page: paragraphs separated by a blank line; chapter headings start with "# ". */
export function pageText(lines) {
  let rows = groupIntoRows(lines);
  if (rows.length > 1 && isPageNumber(rows[rows.length - 1].text)) rows.pop();
  if (rows.length > 1 && isPageNumber(rows[0].text)) rows.shift();
  if (!rows.length) return '';

  const leftMargin = median(rows.map((r) => r.x), 0.25);                // ignores indented lines
  const rightMargin = median(rows.map((r) => r.x + r.width), 0.75);     // ignores short lines
  const gaps = rows.slice(1).map((row, i) => row.y - rows[i].y);
  const typicalGap = gaps.length ? median(gaps) : 0;
  const typicalHeight = median(rows.map((r) => r.height));

  const paragraphs = [];
  let current = '';
  const flush = () => {
    const text = squash(current);
    if (text) paragraphs.push(text);
    current = '';
  };

  rows.forEach((row, index) => {
    const text = squash(row.text);
    if (!text) return;
    const bigShortLine = index <= 2 && typicalHeight > 0 && text.length >= 3 && text.length <= 45
      && row.height > typicalHeight * 1.45 && [...text].some(isLetter);
    if (isChapterHeading(text) || bigShortLine) {
      flush();
      paragraphs.push(HEADING + text);
      return;
    }
    let startsNew = !current;
    if (!startsNew && index > 0) {
      const previous = rows[index - 1];
      const indented = row.x > leftMargin + 0.018;
      const bigGap = typicalGap > 0 && (row.y - previous.y) > typicalGap * 1.55;
      const previousShort = (previous.x + previous.width) < rightMargin - 0.08;
      const previousText = previous.text.trim();
      const previousEnded = SENTENCE_ENDERS.has(previousText[previousText.length - 1]);
      if (indented || bigGap || (previousShort && previousEnded)) startsNew = true;
    }
    if (startsNew) flush();
    current = join(current, text);
  });
  flush();
  return paragraphs.join('\n\n');
}

/** Whole book: joins paragraphs cut by page breaks and splits the text into chapters. */
export function assemble(pages, bookTitle) {
  const paragraphs = [];
  for (const page of pages) {
    const pageParagraphs = (page || '').replace(/\r\n/g, '\n').split(/\n\s*\n/)
      .map((p) => {
        const trimmed = p.trim();
        if (trimmed.startsWith('#')) return squash(trimmed);
        return trimmed.split('\n').reduce((text, line) => join(text, line.trim()), '');
      })
      .filter(Boolean);
    pageParagraphs.forEach((paragraph, index) => {
      const previous = paragraphs[paragraphs.length - 1];
      if (index === 0 && !paragraph.startsWith('#') && previous && !previous.startsWith('#')
          && !SENTENCE_ENDERS.has(previous[previous.length - 1])) {
        paragraphs[paragraphs.length - 1] = join(previous, paragraph);   // sentence cut by the page break
      } else {
        paragraphs.push(paragraph);
      }
    });
  }

  const chapters = [];
  let current = { title: '', paragraphs: [] };
  for (const paragraph of paragraphs) {
    if (paragraph.startsWith('#')) {
      if (current.paragraphs.length || current.title) chapters.push(current);
      current = { title: paragraph.replace(/^[# ]+/, ''), paragraphs: [] };
    } else {
      current.paragraphs.push(paragraph);
    }
  }
  if (current.paragraphs.length || current.title) chapters.push(current);

  // No headings: cut very long text into sections so the reader stays quick.
  const SECTION = 150;
  const result = [];
  for (const chapter of chapters) {
    if (chapter.paragraphs.length <= SECTION * 2) { result.push(chapter); continue; }
    for (let start = 0, part = 1; start < chapter.paragraphs.length; start += SECTION, part += 1) {
      const title = !chapter.title ? '' : (part === 1 ? chapter.title : `${chapter.title} (part ${part})`);
      result.push({ title, paragraphs: chapter.paragraphs.slice(start, start + SECTION) });
    }
  }
  const untitled = result.filter((c) => !c.title);
  untitled.forEach((chapter, index) => {
    chapter.title = untitled.length === 1 ? (bookTitle || 'Text') : `Section ${index + 1}`;
  });
  return result;
}
