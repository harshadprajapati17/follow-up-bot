/**
 * Google Sheets API Route
 * -----------------------
 * This is a secure server-only endpoint. Clients send a POST request with
 * a JSON body describing what they want to do (read or update a sheet).
 * All communication with Google happens on the server; credentials never
 * leave the server.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readSheet, updateSheet } from '@/lib/googleSheets';

// --- Request body types ---
// We expect a JSON body with an "action" and the data needed for that action.

/** Shape of the request body when action is "read". */
interface ReadBody {
  action: 'read';
  spreadsheetId: string;
  range: string;
}

/** Shape of the request body when action is "update". */
interface UpdateBody {
  action: 'update';
  spreadsheetId: string;
  range: string;
  values: string[][];
}

/** Union type: request body can be either read or update. */
type SheetsRequestBody = ReadBody | UpdateBody;

/**
 * Checks if the request body has the required fields for the given action.
 * Returns an error message string if invalid, or null if valid.
 */
function validateBody(body: unknown): body is SheetsRequestBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (b.action !== 'read' && b.action !== 'update') return false;
  if (typeof b.spreadsheetId !== 'string' || !b.spreadsheetId.trim()) return false;
  if (typeof b.range !== 'string' || !b.range.trim()) return false;
  if (b.action === 'update') {
    if (!Array.isArray(b.values)) return false;
    if (!b.values.every((row) => Array.isArray(row) && row.every((c) => typeof c === 'string'))) return false;
  }
  return true;
}

/**
 * POST /api/sheets
 * ----------------
 * Handles read and update operations for Google Sheets. Server-only; credentials
 * never leave the server.
 *
 * Params: none (all input via request body).
 *
 * Payload (JSON body):
 *   - action: "read" | "update"  (required)
 *   - spreadsheetId: string     (required) — Sheet ID from URL (between /d/ and /edit)
 *   - range: string             (required) — A1 notation, e.g. "Sheet1!A1:D10"
 *   - values: string[][]        (required for action "update") — 2D array of cell values
 *
 * Sample cURL — Read range:
 *   curl -X POST http://localhost:3000/api/sheets \
 *     -H "Content-Type: application/json" \
 *     -d '{"action":"read","spreadsheetId":"YOUR_SHEET_ID","range":"Sheet1!A1:D10"}'
 *
 * Sample cURL — Update range:
 *   curl -X POST http://localhost:3000/api/sheets \
 *     -H "Content-Type: application/json" \
 *     -d '{"action":"update","spreadsheetId":"YOUR_SHEET_ID","range":"Sheet1!A1:B2","values":[["Hello","World"],["Row2","Data"]]}'
 *
 * Flow:
 * 1. POST only (no GET) so sheet IDs and ranges are not logged in URLs.
 * 2. Parse and validate JSON body (action, spreadsheetId, range; for update: values).
 * 3. Call readSheet or updateSheet from server-only lib.
 * 4. Return JSON: { success, data? } or { success: false, error }.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!validateBody(body)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid request. Send JSON with action ("read" or "update"), spreadsheetId, range, and for update: values (2D array of strings).',
        },
        { status: 400 }
      );
    }

    const { action, spreadsheetId, range } = body;

    if (action === 'read') {
      const data = await readSheet(spreadsheetId, range);
      if (data === null) {
        return NextResponse.json(
          {
            success: false,
            error: 'Read failed. Check that Google credentials are set (GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY) and the sheet is shared with the service account.',
          },
          { status: 502 }
        );
      }
      return NextResponse.json({ success: true, data });
    }

    if (action === 'update') {
      const ok = await updateSheet(spreadsheetId, range, body.values);
      if (!ok) {
        return NextResponse.json(
          {
            success: false,
            error: 'Update failed. Check credentials and that the sheet is shared with the service account.',
          },
          { status: 502 }
        );
      }
      return NextResponse.json({ success: true, message: 'Sheet updated.' });
    }

    return NextResponse.json(
      { success: false, error: 'Unknown action.' },
      { status: 400 }
    );
  } catch (err) {
    console.error('[api/sheets] Error:', err);
    return NextResponse.json(
      {
        success: false,
        error: 'Request could not be processed. Ensure the body is valid JSON.',
      },
      { status: 400 }
    );
  }
}
