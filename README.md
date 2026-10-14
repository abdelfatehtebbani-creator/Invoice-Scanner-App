# Invoice Scanner

A personal mobile web app that turns photos of invoices and receipts (Arabic, French, English) into
structured rows in Google Sheets, keeps the original image in Google Drive, and lets you review,
correct, search and re-open every invoice.

It runs entirely on your own Google account: Google Apps Script (backend and web app), Google Sheets
(data) and Google Drive (images and free OCR). It is independent of every other project.

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
| `src/Code.js` | `doGet` and the API used by the page (extract, save, list, get, settings), owner check |
| `src/Ocr.js` | Drive OCR and the optional Gemini engine |
| `src/Parser.js` | OCR text → invoice fields and line items, with confidence per field |
| `src/Shared.js` | Number parsing and validation, used by both the server and the page |
| `src/Store.js` | Sheet reads/writes, duplicate search, processing log |
| `src/Index.html`, `src/App.html`, `src/Styles.html` | Mobile interface (Arabic RTL / English) |
| `tests/` | Parser and validation tests, plus a phone-sized browser test of the interface |

## Deploy (one time, from a computer)

Requires Node.js and [clasp](https://github.com/google/clasp) signed in to your Google account
(`npx @google/clasp login`), and the Apps Script API enabled at https://script.google.com/home/usersettings.

```bash
npm test                 # local tests
npx @google/clasp push --force
npx @google/clasp deploy --description "Invoice Scanner"
```

`clasp deploy` prints a deployment ID. To update the app later **without changing its URL**:

```bash
npx @google/clasp push --force
npx @google/clasp deploy -i <deploymentId> --description "update"
```

Then, in the Apps Script editor, run the `setup` function once and accept the Google authorization
screen. It reports which sheets/columns it created and never deletes data.

The web app URL looks like `https://script.google.com/macros/s/<deploymentId>/exec`.
It is deployed as *Execute as: me* and *Who has access: only myself*, so only your Google account
can open it, and every API call re-checks that the caller is the owner.

## Install on your phone

1. Open the web app URL in **Chrome** (Android) or **Safari** (iPhone), signed in to the same
   Google account.
2. Android: menu ⋮ → **Add to Home screen**. iPhone: Share → **Add to Home Screen**.
3. Open it from the icon. Camera access is requested the first time you press *Capture invoice*.

Note: Apps Script cannot serve a service worker, so the app needs a connection (it cannot work
offline) and the home-screen icon opens it in the browser frame.

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
