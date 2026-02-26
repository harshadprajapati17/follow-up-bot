import { readSheet, updateSheet } from './googleSheets';

/** Column index for Owner (matches Telegram first_name). */
const OWNER_COLUMN_INDEX = 2; // column C

function formatMessageDateTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}-${month}-${year} ${hours}:${minutes}`;
}

function columnLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

/**
 * Records the last message for a given owner in the webhook sheet.
 * Finds the row where Owner (column C) matches firstName, writes date/time in row 1
 * of the next empty column and the message text in the data row.
 */
export async function recordLastMessageForOwner(
  firstName: string,
  messageDate: number,
  messageText: string
): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID?.trim();
  if (!spreadsheetId) {
    console.log('[sheetRecording] GOOGLE_SHEET_ID not set, skipping sheet update');
    return;
  }

  const range = 'A1:Z50';
  const rows = await readSheet(spreadsheetId, range);
  if (!rows || rows.length < 2) {
    console.log('[sheetRecording] Sheet empty or no data rows, skipping');
    return;
  }

  const headerRow = rows[0];
  let lastFilledColIndex = -1;
  for (let c = 0; c < (headerRow?.length ?? 0); c++) {
    if (headerRow[c]?.trim()) lastFilledColIndex = c;
  }
  const newColIndex = lastFilledColIndex + 1;
  const colLetter = columnLetter(newColIndex);

  const normalizedName = firstName.trim().toLowerCase();
  let dataRowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    const owner = rows[i][OWNER_COLUMN_INDEX];
    if (owner && owner.trim().toLowerCase() === normalizedName) {
      dataRowIndex = i;
      break;
    }
  }

  if (dataRowIndex === -1) {
    console.log(`[sheetRecording] No sheet row found for Owner "${firstName}", skipping`);
    return;
  }

  const sheetRowNumber = dataRowIndex + 1;
  const dateTimeStr = formatMessageDateTime(messageDate);
  const text = (messageText || '').trim() || '(no text)';

  const row1Range = `${colLetter}1`;
  const headerOk = await updateSheet(spreadsheetId, row1Range, [[dateTimeStr]]);
  if (!headerOk) {
    console.error('[sheetRecording] Failed to write date/time to row 1');
    return;
  }

  const cellRange = `${colLetter}${sheetRowNumber}`;
  const ok = await updateSheet(spreadsheetId, cellRange, [[text]]);
  if (ok) {
    console.log(`[sheetRecording] Recorded last message for "${firstName}" at ${cellRange}`);
  } else {
    console.error('[sheetRecording] Failed to write last message to sheet');
  }
}
