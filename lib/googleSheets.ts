/**
 * Google Sheets Backend Integration (server-only)
 * -----------------------------------------------
 * This module is intended for use in API routes or server code only. It connects
 * to Google Sheets using a "service account" (like a robot user) and provides
 * simple read and update functions for spreadsheet data.
 */

import { google } from 'googleapis';

// --- Configuration from environment ---
// These values come from .env and must be set for the integration to work.
// GOOGLE_PROJECT_ID: Your Google Cloud project identifier.
// GOOGLE_CLIENT_EMAIL: The service account email (e.g. from JSON key file).
// GOOGLE_PRIVATE_KEY: The private key from the same JSON key (handles \n in env).
const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY
  ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : undefined;

/** Scope that allows reading and writing Google Sheets only (no other Google data). */
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/**
 * Creates an authenticated Google Sheets API client.
 * Uses JWT (JSON Web Token) authentication: we prove who we are using
 * the service account's email and private key, and get permission to
 * access only spreadsheets.
 *
 * @returns Authenticated sheets client, or null if credentials are missing/invalid
 */
function getSheetsClient() {
  if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    return null;
  }

  const auth = new google.auth.JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: SCOPES,
    ...(GOOGLE_PROJECT_ID && { projectId: GOOGLE_PROJECT_ID }),
  });

  return google.sheets({ version: 'v4', auth });
}

/**
 * Reads data from a range in a Google Sheet.
 * Example range: "Sheet1!A1:D10" (cells A1 to D10 on Sheet1).
 *
 * @param spreadsheetId - The ID from the sheet's URL (long string between /d/ and /edit)
 * @param range - A1 notation range (e.g. "Sheet1!A1:D10")
 * @returns The cell values as a 2D array (rows of columns), or null on error
 */
export async function readSheet(
  spreadsheetId: string,
  range: string
): Promise<string[][] | null> {
  const sheets = getSheetsClient();
  if (!sheets) {
    return null;
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    const rows = response.data.values;
    // API returns undefined when range is empty; we return empty array for consistency
    return rows ?? [];
  } catch (err) {
    console.error('[googleSheets] readSheet error:', err);
    return null;
  }
}

/**
 * Writes (or updates) data in a Google Sheet range.
 * If the range already has data, it will be overwritten. The range size
 * determines how many rows/columns are updated.
 *
 * @param spreadsheetId - The ID from the sheet's URL
 * @param range - A1 notation range (e.g. "Sheet1!A1:D10")
 * @param values - 2D array of values (rows of columns)
 * @returns true if the update succeeded, false otherwise
 */
export async function updateSheet(
  spreadsheetId: string,
  range: string,
  values: string[][]
): Promise<boolean> {
  const sheets = getSheetsClient();
  if (!sheets) {
    return false;
  }

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED', // Formulas and formatting behave like user typing
      requestBody: { values },
    });
    return true;
  } catch (err) {
    console.error('[googleSheets] updateSheet error:', err);
    return false;
  }
}

/**
 * Optional: append rows to the end of a sheet (no overwrite).
 * Useful for logging or adding new rows without touching existing data.
 *
 * @param spreadsheetId - The ID from the sheet's URL
 * @param range - A1 notation for the table (e.g. "Sheet1!A:D"); rows are appended below
 * @param values - 2D array of rows to append
 * @returns true if append succeeded, false otherwise
 */
export async function appendToSheet(
  spreadsheetId: string,
  range: string,
  values: string[][]
): Promise<boolean> {
  const sheets = getSheetsClient();
  if (!sheets) {
    return false;
  }

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
    return true;
  } catch (err) {
    console.error('[googleSheets] appendToSheet error:', err);
    return false;
  }
}
