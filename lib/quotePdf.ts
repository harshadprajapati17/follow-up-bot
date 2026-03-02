import { PDFDocument, StandardFonts } from 'pdf-lib';

type QuoteEntities = Record<string, unknown>;

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

export async function buildQuotePdfBuffer(
  entities: QuoteEntities
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();

  const margin = 50;
  let cursorY = height - margin;

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontSizeTitle = 18;
  const fontSizeLabel = 11;
  const fontSizeValue = 11;
  const lineGap = 18;

  function drawText(
    text: string,
    options: { bold?: boolean; size?: number } = {}
  ) {
    const usedFont = options.bold ? fontBold : font;
    const size = options.size ?? fontSizeValue;
    if (cursorY < margin) {
      // In a more complex implementation we would add a new page.
      return;
    }
    page.drawText(text, {
      x: margin,
      y: cursorY,
      size,
      font: usedFont,
    });
    cursorY -= lineGap;
  }

  // Title
  drawText('Painting Quote Summary', { bold: true, size: fontSizeTitle });
  cursorY -= 6;

  const customerName = asString(entities['customer_name']) ?? '-';
  const customerPhone = asString(entities['customer_phone']) ?? '-';
  const locationText = asString(entities['location_text']) ?? '-';

  drawText(`Customer: ${customerName}`, { bold: true, size: fontSizeLabel });
  drawText(`Phone: ${customerPhone}`, { size: fontSizeValue });
  drawText(`Location: ${locationText}`, { size: fontSizeValue });

  cursorY -= lineGap / 2;
  drawText('Scope & Measurement', { bold: true, size: fontSizeLabel });

  const paintableArea = asString(entities['paintable_area_sqft']) ?? '-';
  const ceilingIncluded =
    typeof entities['ceiling_included'] === 'boolean'
      ? entities['ceiling_included']
        ? 'Yes'
        : 'No'
      : '-';
  const prepLevel = asString(entities['prep_level']) ?? '-';
  const dampIssue = entities['damp_issue'] as
    | { has_issue?: boolean; locations?: string }
    | undefined;
  const dampSummary =
    dampIssue && typeof dampIssue === 'object'
      ? (dampIssue.has_issue ? 'Yes' : 'No') +
        (dampIssue.locations ? ` (${dampIssue.locations})` : '')
      : '-';
  const scrapeRequired =
    typeof entities['scrape_required'] === 'boolean'
      ? entities['scrape_required']
        ? 'Yes'
        : 'No'
      : '-';

  drawText(`Paintable area (sqft): ${paintableArea}`);
  drawText(`Ceiling included: ${ceilingIncluded}`);
  drawText(`Prep level: ${prepLevel}`);
  drawText(`Damp issue: ${dampSummary}`);
  drawText(`Scraping required: ${scrapeRequired}`);

  const brandPreference = asString(entities['brand_preference']) ?? '-';
  const finish = asString(entities['finish']) ?? '-';
  const finishQuality = asString(entities['finish_quality']) ?? '-';

  cursorY -= lineGap / 2;
  drawText('Product Preferences', { bold: true, size: fontSizeLabel });
  drawText(`Brand preference: ${brandPreference}`);
  drawText(`Finish: ${finish}`);
  drawText(`Finish quality: ${finishQuality}`);

  const quoteType = asString(entities['quote_type']) ?? '-';
  const rateBand = asString(entities['rate_band']) ?? '-';
  const timelineDays = asString(entities['timeline_days']) ?? '-';

  const advance = entities['advance'] as
    | { type?: string; value?: unknown }
    | undefined;
  const advanceType = advance?.type ? String(advance.type) : '-';
  const advanceValue =
    advance && 'value' in advance
      ? asString((advance as { value?: unknown }).value)
      : null;

  cursorY -= lineGap / 2;
  drawText('Quote Options', { bold: true, size: fontSizeLabel });
  drawText(`Quote type: ${quoteType}`);
  drawText(`Rate band: ${rateBand}`);
  drawText(`Timeline: ${timelineDays}`);
  drawText(
    `Advance: ${advanceType}${
      advanceValue ? ` (${advanceValue})` : ''
    }`
  );

  const roomsRaw = entities['rooms'];
  if (Array.isArray(roomsRaw) && roomsRaw.length > 0) {
    cursorY -= lineGap / 2;
    drawText('Rooms', { bold: true, size: fontSizeLabel });
    roomsRaw.forEach((room, index) => {
      const name =
        room && typeof room === 'object'
          ? asString((room as Record<string, unknown>)['name']) ?? `Room ${index + 1}`
          : `Room ${index + 1}`;
      const area =
        room && typeof room === 'object'
          ? asString((room as Record<string, unknown>)['area_sqft'])
          : null;
      const line = area ? `${name} — ${area} sqft` : name;
      drawText(line);
    });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

