// Reads the words off a photographed page, right in the browser (Tesseract). Nothing is uploaded.

let scriptLoading = null;
let worker = null;
let workerLanguages = '';

function loadTesseract() {
  if (!scriptLoading) {
    scriptLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/tesseract/tesseract.min.js';
      script.onload = resolve;
      script.onerror = () => { scriptLoading = null; reject(new Error("The text reader couldn't be loaded. Check the internet connection and try again.")); };
      document.head.appendChild(script);
    });
  }
  return scriptLoading;
}

const absolute = (path) => new URL(path, document.baseURI).href;

export const SCAN_LANGUAGES = [
  { id: 'eng', label: 'English', code: 'en' },
  { id: 'afr', label: 'Afrikaans', code: 'af' },
  { id: 'eng+afr', label: 'English and Afrikaans mixed', code: 'en' }
];

/**
 * Returns the lines on the page as [{ text, x, y, width, height }], positions as fractions of the page.
 * `onProgress` gets a number from 0 to 1.
 */
export async function readPage(blob, width, height, languages = 'eng', onProgress = () => {}) {
  await loadTesseract();
  readPage.progress = onProgress;
  if (!worker || workerLanguages !== languages) {
    if (worker) { try { await worker.terminate(); } catch (error) { /* already gone */ } }
    worker = await globalThis.Tesseract.createWorker(languages, 1, {
      workerPath: absolute('vendor/tesseract/worker.min.js'),
      corePath: absolute('vendor/tesseract/core'),
      langPath: absolute('vendor/tesseract/lang'),
      logger: (message) => { if (message.status === 'recognizing text') readPage.progress(message.progress); }
    });
    workerLanguages = languages;
  }
  const { data } = await worker.recognize(blob, {}, { blocks: true });

  const found = [];
  const collect = (line) => {
    const box = line.bbox;
    if (!box || !line.text || !line.text.trim()) return;
    found.push({
      text: line.text.replace(/\s+/g, ' ').trim(),
      x: box.x0 / width,
      y: box.y0 / height,
      width: (box.x1 - box.x0) / width,
      height: (box.y1 - box.y0) / height
    });
  };
  if (Array.isArray(data.blocks)) {
    for (const block of data.blocks) for (const paragraph of block.paragraphs || []) for (const line of paragraph.lines || []) collect(line);
  } else if (Array.isArray(data.lines)) {
    data.lines.forEach(collect);
  }
  return found;
}
readPage.progress = () => {};

export async function stopReader() {
  if (worker) { try { await worker.terminate(); } catch (error) { /* already gone */ } }
  worker = null;
  workerLanguages = '';
}
