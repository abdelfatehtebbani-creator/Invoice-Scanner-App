/**
 * Project configuration. Resource IDs are not secrets: the spreadsheet and the
 * folder stay private in the owner's Google Drive and only this script, running
 * as the owner, can open them.
 * Secrets such as the optional Gemini API key live in Script Properties and
 * never reach the browser.
 */
var CONFIG = {
  APP_NAME: 'Invoice Scanner',
  APP_URL: 'https://abdelfatehtebbani-creator.github.io/Invoice-Scanner-App/',
  SPREADSHEET_NAME: 'InvoiceScanner_Data',
  FOLDER_NAME: 'InvoiceScanner_Images',
  // Resources the owner created for this app. If one of them cannot be opened,
  // setup looks it up by name and only creates a new one as a last resort.
  DEFAULT_SPREADSHEET_ID: '1sXp51wMBlK-3otmCCtyP7seJSah-v9d-7GiTSl1dUOw',
  DEFAULT_FOLDER_ID: '1iwelBXZXmlz8hXSlHfHeQ6fAeQEYih84',
  SETUP_VERSION: '3',
  // Default Gemini model; can be changed with the GEMINI_MODEL script property.
  GEMINI_MODEL: 'gemini-flash-latest',
  MAX_IMAGE_BYTES: 15 * 1024 * 1024,
  PENDING_PREFIX: 'PENDING_',
  PENDING_MAX_AGE_DAYS: 7
};

var SHEETS = {
  INVOICES: {
    name: 'Invoices',
    headers: [
      'InvoiceID', 'Type', 'InvoiceNumber', 'InvoiceDate', 'PartyName', 'PartyTaxID', 'Currency',
      'Subtotal', 'DiscountTotal', 'TaxTotal', 'Total', 'AmountPaid', 'PaymentMethod',
      'ItemCount', 'ItemsSum', 'ReviewStatus', 'ProcessingStatus', 'Issues', 'UncertainFields',
      'OcrEngine', 'Language', 'ImageFileID', 'ImageURL', 'ImageHash', 'BusinessKey', 'RequestID',
      'Notes', 'CreatedAt', 'UpdatedAt'
    ],
    textColumns: ['InvoiceID', 'InvoiceNumber', 'PartyTaxID', 'ImageFileID', 'ImageHash', 'BusinessKey', 'RequestID'],
    dateColumns: ['InvoiceDate'],
    timestampColumns: ['CreatedAt', 'UpdatedAt'],
    moneyColumns: ['Subtotal', 'DiscountTotal', 'TaxTotal', 'Total', 'AmountPaid', 'ItemsSum']
  },
  ITEMS: {
    name: 'InvoiceItems',
    headers: [
      'ItemID', 'InvoiceID', 'LineNo', 'Description', 'Quantity', 'Unit', 'UnitPrice', 'Discount',
      'TaxRate', 'TaxAmount', 'LineTotal', 'CalculatedTotal', 'Confidence', 'Flags'
    ],
    textColumns: ['ItemID', 'InvoiceID'],
    dateColumns: [],
    timestampColumns: [],
    moneyColumns: ['UnitPrice', 'Discount', 'TaxAmount', 'LineTotal', 'CalculatedTotal']
  },
  LOG: {
    name: 'ProcessingLog',
    headers: [
      'Timestamp', 'RequestID', 'Stage', 'Status', 'InvoiceID', 'ImageFileID', 'ImageHash',
      'Engine', 'DurationMs', 'Message'
    ],
    textColumns: ['RequestID', 'InvoiceID', 'ImageFileID', 'ImageHash'],
    dateColumns: [],
    timestampColumns: ['Timestamp'],
    moneyColumns: []
  }
};

var REVIEW_STATUS = {
  NEEDS_REVIEW: 'Needs review',          // saved with open issues, not confirmed
  CONFIRMED_WITH_ISSUES: 'Confirmed with issues', // user explicitly accepted the flagged values
  VERIFIED: 'Verified'                   // reviewed and no issues remain
};
