import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import Sanscript from '@indic-transliteration/sanscript';
import type { QuoteResult } from './v2/quote-calculator';

type QuoteEntities = Record<string, unknown>;

/** Returns true if text has characters outside the WinAnsi-safe range. */
function hasNonAscii(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}

/**
 * Detect which Indic script a character belongs to and return the Sanscript
 * scheme name, or null for non-Indic/ASCII.
 */
function detectIndicScript(text: string): string | null {
  if (/[\u0900-\u097F]/.test(text)) return 'devanagari';
  if (/[\u0A80-\u0AFF]/.test(text)) return 'gujarati';
  if (/[\u0A00-\u0A7F]/.test(text)) return 'gurmukhi';
  if (/[\u0980-\u09FF]/.test(text)) return 'bengali';
  if (/[\u0B80-\u0BFF]/.test(text)) return 'tamil';
  if (/[\u0C00-\u0C7F]/.test(text)) return 'telugu';
  if (/[\u0C80-\u0CFF]/.test(text)) return 'kannada';
  if (/[\u0D00-\u0D7F]/.test(text)) return 'malayalam';
  return null;
}

/**
 * Convert any Indic-script text to Latin (ITRANS) so WinAnsi-encoded PDF
 * fonts can render it. Pure ASCII strings pass through unchanged.
 * After transliteration, any remaining non-ASCII chars are stripped as a
 * safety net so pdf-lib never throws.
 */
function toLatinPdf(text: string): string {
  if (!hasNonAscii(text)) return text;
  try {
    const script = detectIndicScript(text);
    if (script) {
      const transliterated = Sanscript.t(text, script, 'itrans');
      return transliterated.replace(/[^\x00-\x7F]/g, '');
    }
  } catch {
    // fall through to strip
  }
  return text.replace(/[^\x00-\x7F]/g, '');
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  return null;
}

/** Like asString but guaranteed safe for WinAnsi PDF fonts. */
function asLatinString(value: unknown): string | null {
  const s = asString(value);
  return s !== null ? toLatinPdf(s) : null;
}

function formatINR(amount: number): string {
  return `Rs.${amount.toLocaleString('en-IN')}`;
}

export async function buildQuotePdfBuffer(
  entities: QuoteEntities,
  quoteResult?: QuoteResult
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();

  const margin = 50;
  let cursorY = height - margin;

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontSizeTitle = 18;
  const fontSizeSection = 12;
  const fontSizeBody = 10;
  const lineGap = 16;

  function drawText(
    text: string,
    options: { bold?: boolean; size?: number; x?: number; color?: [number, number, number] } = {}
  ) {
    const usedFont = options.bold ? fontBold : font;
    const size = options.size ?? fontSizeBody;
    if (cursorY < margin) return;
    // Always sanitize to Latin so WinAnsi never receives Devanagari codepoints
    page.drawText(toLatinPdf(text), {
      x: options.x ?? margin,
      y: cursorY,
      size,
      font: usedFont,
      color: options.color ? rgb(options.color[0], options.color[1], options.color[2]) : undefined,
    });
    cursorY -= lineGap;
  }

  function drawDivider() {
    if (cursorY < margin) return;
    page.drawLine({
      start: { x: margin, y: cursorY + lineGap / 2 },
      end: { x: width - margin, y: cursorY + lineGap / 2 },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });
    cursorY -= 4;
  }

  // ── Title
  drawText('Painting Quote', { bold: true, size: fontSizeTitle });
  cursorY -= 4;
  drawDivider();

  // ── Customer
  const customerName = asLatinString(entities['customer_name']) ?? '-';
  const customerPhone = asLatinString(entities['customer_phone']) ?? '-';
  const locationText = asLatinString(entities['location_text']) ?? '-';
  drawText(`Customer: ${customerName}`, { bold: true, size: fontSizeSection });
  drawText(`Phone: ${customerPhone}`);
  drawText(`Location: ${locationText}`);
  cursorY -= 4;

  // ── Scope summary
  drawDivider();
  drawText('Scope', { bold: true, size: fontSizeSection });
  const paintableArea =
    asString(entities['paintable_area_sqft']) ??
    asString(entities['measurement_area']) ??
    '-';
  drawText(`Paintable area: ${paintableArea} sqft`);

  const puttyCoats = entities['putty_coats'];
  if (puttyCoats !== undefined && puttyCoats !== null) {
    drawText(`Putty: ${puttyCoats} coat${Number(puttyCoats) !== 1 ? 's' : ''}`);
  }
  const primerIncl = entities['primer_included'];
  if (primerIncl !== undefined) {
    drawText(`Primer: ${primerIncl ? 'Yes' : 'No'}`);
  }
  const scrape = entities['scrape_required'];
  if (scrape) drawText('Scraping old paint: Yes');
  const damp = asLatinString(entities['damp_issue']);
  if (damp && damp.toLowerCase() !== 'none') drawText(`Damp issue: ${damp}`);
  cursorY -= 4;

  // ── Itemized pricing (only if quoteResult is available)
  if (quoteResult) {
    drawDivider();
    drawText('Cost Breakdown', { bold: true, size: fontSizeSection });

    const labelX = margin;
    const amtX = width - margin - 70;

    // Header row
    drawText('Item', { bold: true, x: labelX });
    page.drawText('Amount', {
      x: amtX,
      y: cursorY + lineGap,
      size: fontSizeBody,
      font: fontBold,
    });

    for (const item of quoteResult.line_items) {
      const label = `${item.label} (${item.area_sqft} sqft x Rs.${item.rate_per_sqft}/sqft)`;
      drawText(label, { x: labelX });
      page.drawText(formatINR(item.amount), {
        x: amtX,
        y: cursorY + lineGap,
        size: fontSizeBody,
        font,
      });
    }

    cursorY -= 4;
    drawDivider();

    // Subtotal
    drawText('Subtotal', { bold: true, x: labelX });
    page.drawText(formatINR(quoteResult.subtotal), {
      x: amtX,
      y: cursorY + lineGap,
      size: fontSizeBody,
      font: fontBold,
    });

    drawText(`GST (${quoteResult.gst_percent}%)`, { x: labelX });
    page.drawText(formatINR(quoteResult.gst_amount), {
      x: amtX,
      y: cursorY + lineGap,
      size: fontSizeBody,
      font,
    });

    cursorY -= 2;
    drawDivider();

    drawText('TOTAL', { bold: true, size: fontSizeSection, x: labelX });
    page.drawText(formatINR(quoteResult.total), {
      x: amtX,
      y: cursorY + lineGap,
      size: fontSizeSection,
      font: fontBold,
    });

    cursorY -= 4;
    drawText(
      quoteResult.quote_type === 'LABOUR_PLUS_MATERIAL'
        ? `Includes: Labour + ${quoteResult.brand_name} ${quoteResult.product_name}`
        : 'Labour only (material cost not included)',
      { color: [0.4, 0.4, 0.4] }
    );
  } else {
    // Fallback — legacy display without pricing
    drawDivider();
    drawText('Quote Details', { bold: true, size: fontSizeSection });
    const quoteType = asString(entities['quote_type']) ?? '-';
    const timelineDays = asString(entities['timeline_days']) ?? '-';
    const advance = asString(entities['advance']) ?? '-';
    drawText(`Quote type: ${quoteType}`);
    drawText(`Timeline: ${timelineDays}`);
    drawText(`Advance: ${advance}`);
  }

  const timelineDays = asString(entities['timeline_days']);
  const advance = asString(entities['advance']);
  if (timelineDays || advance) {
    cursorY -= 4;
    drawDivider();
    drawText('Terms', { bold: true, size: fontSizeSection });
    if (timelineDays) drawText(`Timeline: ${timelineDays}`);
    if (advance) drawText(`Advance: ${advance}`);
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
