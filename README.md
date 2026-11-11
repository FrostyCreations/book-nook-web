# Book Nook (web app)

Find free books, turn paper books you own into ebooks, and read them. Made for an iPad, installed from Safari with "Add to Home Screen". No App Store, no Apple account, nothing to renew.

## Put it online (Vercel)

1. Put this folder in a GitHub repo.
2. In Vercel: Add New, Project, import the repo. Framework preset "Other". Leave the build command and output directory empty. Deploy.
3. Open the Vercel address on the iPad **in Safari**, tap Share, then "Add to Home Screen".

Do step 3 before adding any books. The Home Screen app keeps its own storage, so books added in a Safari tab don't carry over.

## What's in it

| Tab | What it does |
|---|---|
| **My Books** | The shelf. Tap a cover to read; it remembers the place. "Add a file" takes EPUB or PDF from the Files app. |
| **Find Books** | Searches 9 free libraries at once and downloads to the shelf. Newer, in-copyright books show up under Open Library lending, where they can be borrowed and read online with a free account. Shelves (Vampires, Love stories…) browse by subject. |
| **Scan a Book** | Photograph pages; the words are read in the browser (nothing is uploaded) and become a real EPUB. Picture books become an EPUB of the photos. Scans are kept, so a book can be done over many sittings. |
| **More Libraries** | 52 more free libraries, opened in Safari. Download there, then "Add a file". |

## How it works

- Plain HTML, CSS and JavaScript. No build step.
- Books, covers and scans live on the iPad in the browser's database (IndexedDB). Nothing is stored on a server.
- `api/fetch.js` is a small Vercel function that downloads book files from the libraries, because browsers aren't allowed to fetch most of them directly. It only talks to the libraries on its list.
- Text recognition is Tesseract (English and Afrikaans included, about 9 MB, loaded the first time she scans).
- `sw.js` keeps the app available offline, so books on the shelf can be read without internet.

## Tested, and not

Run in headless Chrome against the live libraries: search, download, shelf, the EPUB reader (contents, text size, colours, remembering the place), the PDF reader, adding photos, reading the words, and building the ebook. The EPUB it builds passes the official EPUB checker.

Not tested: a real iPad. Safari is a different browser engine, so the camera button, Add to Home Screen, and storage should be tried on her iPad before relying on it. OAPEN and Wikisource (Afrikaans) refused requests from the test machine, so those two searches are unconfirmed.

## Good to know

- Reading words from photos works best on clean, flat, well-lit pages, one page per photo, the right way up.
- Internet Archive's EPUB files are made by machine and can be rough; its "PDF (page scans)" option shows the original pages.
- Books with copy protection (Kindle or Apple Books purchases) can't be opened.
- iPadOS can clear a web app's storage if the iPad runs very low on space. "Save a copy of the file" on a book's menu makes a backup in Files.
- To add a library to the search, add a source in `core/sources.js` and its website to the list in `api/fetch.js`.

Bundled libraries: JSZip (MIT), Tesseract.js (Apache 2.0), PDF.js (Apache 2.0).
