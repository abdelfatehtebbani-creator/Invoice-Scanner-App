# Invoice Scanner

A personal mobile web app that turns photos of invoices and receipts (Arabic, French, English) into
structured rows in Google Sheets, keeps the original image in Google Drive, and lets you review,
correct, search and re-open every invoice.

- **App (PWA):** `app/`, published to GitHub Pages at
  https://abdelfatehtebbani-creator.github.io/Invoice-Scanner-App/ (installable, own icon, no Apps Script banner).
- **API:** `src/`, a Google Apps Script web app running as the owner. It reads and writes Google Sheets
  (data) and Google Drive (images and free OCR).
- **Sign-in:** a PIN (6–8 digits). Every data request needs the owner's signed token; the code
  contains no secret. It is independent of every other project.

## How it works

1. **Capture or pick** a photo (or PDF). The phone shrinks it to a readable JPEG before uploading.
2. **Extract.** The image is stored in `InvoiceScanner_Images` and read by one of two engines:
   - **Drive OCR** (default, free): Google Drive converts the image to text, then `Parser.js`
     rebuilds the header fields and the item table (handles Arabic-Indic digits, `1 234,56` /
     `1,234.56` formats, DZD/EUR/USD/SAR/… currencies, wrapped descriptions and tables that OCR
     reads column by column).
   - **Gemini** (optional): reads the image directly and returns structured JSON. Much better on
     complex tables. Only used if you add a key in Settings (see costs below).
3. **Review.** Every field shows whether it was read confidently. Uncertain values are yellow,
   missing required values are red, rows whose `qty × price − discount` does not match the printed
   line total are red, and the totals panel compares items, subtotal, discount, tax and total.
4. **Save.** Data goes to `Invoices` and `InvoiceItems`; every step is logged in `ProcessingLog`.
   Status is never set silently:
   - `Verified`: no open issues.
   - `Confirmed with issues`: you ticked "I have checked the flagged values".
   - `Needs review`: saved with open issues you did not confirm. Open it later and press **Edit**.
5. **History / Details.** Search by supplier, customer, invoice number; filter by type, status
   and date; open the original image in Drive.

### Duplicate protection

- Each scan has a request ID. Pressing Save twice, or a network retry, returns the invoice already
  saved instead of writing a second copy (script lock + `ProcessingLog` + cache).
- Before saving, the app looks for the same image (SHA-256), the same type + party + number + date
  + total, or the same party + invoice number. If found, saving is blocked until you choose
  **Save anyway**.

## Files

| File | Purpose |
| --- | --- |
| `src/appsscript.json` | Manifest: V8, time zone, OAuth scopes, web app access = only me |
| `src/Config.js` | Spreadsheet/folder IDs, sheet columns, status names |
| `src/Setup.js` | `setup()`: verifies or creates the spreadsheet, the 3 sheets, columns and the image folder |
| `src/Code.js` | `doPost` JSON API used by the app (extract, save, list, get, settings) |
| `src/Auth.js` | PIN setup with a one-time code, sign-in lockout, signed tokens, `resetPin()` |
| `src/Ocr.js` | Drive OCR and the optional Gemini engine |
| `src/Parser.js` | OCR text → invoice fields and line items, with confidence per field |
| `src/Shared.js` | Number parsing and validation, used by both the server and the page |
| `src/Store.js` | Sheet reads/writes, duplicate search, processing log |
| `app/index.html`, `app/js/app.js`, `app/css/app.css` | Mobile interface (Arabic RTL / English) |
| `app/js/shared.js` | Copy of `src/Shared.js` (`npm run sync`; a test checks they match) |
| `app/js/config.js` | Address of the Apps Script API |
| `app/manifest.webmanifest`, `app/sw.js`, `app/icons/` | PWA install data, offline app shell, icons |
| `.github/workflows/pages.yml` | Publishes `app/` to GitHub Pages on every push to `main` |
| `tests/` | Parser, validation and sign-in tests, plus a phone-sized browser test of the app |

## Deploy

API (from the computer where clasp is signed in to the owner account):

```bash
npm test
npx @google/clasp push --force
npx @google/clasp update-deployment AKfycbydRt_CBITfNIMCNqgBTq00KU-uJKU2XdXe7aSz8HRjd2PJbCWwKxtcJf-ymovyp7Of0w --description "update"
```

Updating the existing deployment keeps the API address used in `app/js/config.js`.
The manifest deploys it as *Execute as: me* and *Who has access: anyone* so the app can reach it;
the PIN token protects every data action.

App: push to `main`; the GitHub Actions workflow publishes `app/` to GitHub Pages
(repository Settings → Pages → Source: GitHub Actions). Bump `VERSION` in `app/sw.js` on each release.

## First use

1. Open https://abdelfatehtebbani-creator.github.io/Invoice-Scanner-App/
2. The app asks for a **setup code**. Open the `InvoiceScanner_Data` spreadsheet, sheet
   `ProcessingLog`: the last row says `Invoice Scanner setup code: 123456` (valid 60 minutes;
   a new one is written when it expires). Only you can open that spreadsheet.
3. Choose a PIN of 6 to 8 digits. The device stays signed in for 90 days.
4. Forgot the PIN? In the Apps Script editor run `resetPin`, then open the app again to get a new
   setup code. Five wrong PINs lock sign-in for 15 minutes.

## Install on your phone or computer

- Android (Chrome): open the app, menu ⋮ → **Install app** / **Add to Home screen**.
- iPhone (Safari): Share → **Add to Home Screen**.
- Computer (Chrome/Edge): the install icon in the address bar, or menu → **Install Invoice Scanner**.

The app opens in its own window with its own icon. It needs a connection to scan or save.

## Settings

- **Invoice language**: optional OCR hint (Arabic, French, English or automatic).
- **Your business name**: helps Gemini tell sales invoices (issued by you) from purchases.
- **Gemini API key**: optional. Create one at https://aistudio.google.com/apikey and paste it in
  Settings. It is stored in Script Properties on the server and never sent back to the page.
  Remove it at any time to return to Drive OCR.

## Costs and limits

| Service | Cost | Limits to know |
| --- | --- | --- |
| Apps Script, Sheets, Drive, Drive OCR | Free with a Google account | Apps Script quotas (e.g. 6 min per call, URL fetch ~20k/day); Drive storage counts toward your 15 GB |
| Gemini API (optional) | Free tier, no billing needed | Per-minute and per-day request limits; on the free tier Google may use submitted content to improve its products. A paid tier exists only if you attach billing to the key's project |

Nothing paid is enabled by this project.

## Accuracy notes

- Drive OCR returns text without table structure. The parser recovers items when each row's
  numbers are on one line or when columns come out one after another, and marks every guess as
  uncertain. Handwritten, crumpled, low-light or very long receipts can still need manual
  correction. Gemini handles these much better.
- Dates such as `05/10/2026` are read day-first and flagged as uncertain when both orders are
  possible.
- Taxes and currencies are never assumed: the app only compares the amounts that are printed.
