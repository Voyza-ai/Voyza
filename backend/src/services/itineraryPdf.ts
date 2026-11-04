import PDFDocument from 'pdfkit';

/**
 * Itinerary PDF for a Duffel order, built server-side with pdfkit (built-in
 * Helvetica — no font files to ship). Reads only the order object, so the
 * same function serves the confirmation email attachment and the download.
 */

const BLUE = '#2563eb';
const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';

const fmtDateTime = (iso: string | null | undefined) => {
  // Duffel times are local wall-clock at the airport, with no offset. Show
  // them as written instead of shifting them through the server's zone.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso ?? '');
  if (!m) return '—';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${day}, ${m[4]}:${m[5]}`;
};

const fmtDuration = (iso: string | null | undefined) => {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(iso ?? '');
  if (!m) return '';
  const h = Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0);
  const min = Number(m[3] ?? 0);
  return `${h ? `${h}h ` : ''}${min ? `${min}m` : ''}`.trim();
};

const money = (amount: string | number, currency: string) => {
  const n = typeof amount === 'number' ? amount : parseFloat(amount);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
};

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function itineraryFilename(order: any): string {
  return `BlueMurr-itinerary-${order?.booking_reference || order?.id || 'booking'}.pdf`;
}

export function buildItineraryPdf(order: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: {
        Title: `Flight itinerary ${order?.booking_reference ?? ''}`.trim(),
        Author: 'BlueMurr',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;

    // Header
    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(22).text('BlueMurr', left, 48);
    doc.fillColor(MUTED).font('Helvetica').fontSize(10).text('Flight itinerary', left, 74);
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(10)
      .text('Booking reference', left, 48, { width, align: 'right' });
    doc
      .fillColor(BLUE)
      .font('Courier-Bold')
      .fontSize(20)
      .text(order?.booking_reference ?? '—', left, 62, { width, align: 'right' });

    if (order?.live_mode === false) {
      doc
        .fillColor('#b45309')
        .font('Helvetica-Bold')
        .fontSize(9)
        .text('TEST BOOKING — not a valid travel document', left, 92, { width, align: 'right' });
    }

    let y = 116;
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 14;

    const kv = (label: string, value: string, x: number, yy: number, w: number, size = 11) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label.toUpperCase(), x, yy, { width: w });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(size).text(value, x, yy + 11, { width: w, lineBreak: false });
    };
    const col = width / 3;
    kv('Airline', order?.owner?.name ?? '—', left, y, col);
    kv('Order', order?.id ?? '—', left + col, y, col, 8.5);
    // created_at is a real UTC instant, unlike the airport-local flight times.
    kv('Booked', `${fmtDateTime(order?.created_at)} UTC`, left + 2 * col, y, col);
    y += 44;

    // Flights
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text('Flights', left, y);
    y += 22;
    for (const slice of order?.slices ?? []) {
      for (const seg of slice?.segments ?? []) {
        if (y > doc.page.height - 160) {
          doc.addPage();
          y = 48;
        }
        const boxH = 78;
        doc.roundedRect(left, y, width, boxH, 8).fillColor('#f0f4f8').fill();
        const fn = `${seg?.marketing_carrier?.iata_code ?? ''} ${seg?.marketing_carrier_flight_number ?? ''}`.trim();
        doc
          .fillColor(BLUE)
          .font('Helvetica-Bold')
          .fontSize(10)
          .text(`${fn}  ·  ${seg?.operating_carrier?.name ?? seg?.marketing_carrier?.name ?? ''}`, left + 14, y + 10);
        const cabin = seg?.passengers?.[0]?.cabin_class_marketing_name ?? seg?.passengers?.[0]?.cabin_class;
        doc
          .fillColor(MUTED)
          .font('Helvetica')
          .fontSize(9)
          .text([cabin, fmtDuration(seg?.duration), seg?.aircraft?.name].filter(Boolean).join('  ·  '), left + 14, y + 10, {
            width: width - 28,
            align: 'right',
          });

        const half = (width - 28) / 2;
        const place = (p: any, terminal?: string | null) =>
          `${p?.name ?? ''}${terminal ? ` · Terminal ${terminal}` : ''}`;
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(seg?.origin?.iata_code ?? '', left + 14, y + 28);
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(fmtDateTime(seg?.departing_at), left + 60, y + 30);
        doc.fillColor(MUTED).fontSize(8).text(place(seg?.origin, seg?.origin_terminal), left + 14, y + 52, {
          width: half - 10,
          ellipsis: true,
          height: 20,
        });
        doc
          .fillColor(INK)
          .font('Helvetica-Bold')
          .fontSize(16)
          .text(seg?.destination?.iata_code ?? '', left + 14 + half, y + 28);
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(fmtDateTime(seg?.arriving_at), left + 60 + half, y + 30);
        doc
          .fillColor(MUTED)
          .fontSize(8)
          .text(place(seg?.destination, seg?.destination_terminal), left + 14 + half, y + 52, {
            width: half - 10,
            ellipsis: true,
            height: 20,
          });
        y += boxH + 10;
      }
    }

    // Passengers
    y += 6;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text('Travellers', left, y);
    y += 20;
    for (const p of order?.passengers ?? []) {
      const name = [p?.title ? titleCase(p.title) : '', p?.given_name, p?.family_name].filter(Boolean).join(' ');
      doc.fillColor(INK).font('Helvetica').fontSize(10).text(name, left, y);
      doc
        .fillColor(MUTED)
        .fontSize(9)
        .text(p?.type ? titleCase(p.type) : '', left, y, { width, align: 'right' });
      y += 16;
    }
    const docs = order?.documents ?? [];
    if (docs.length > 0) {
      y += 4;
      doc
        .fillColor(MUTED)
        .fontSize(9)
        .text(`Ticket${docs.length > 1 ? 's' : ''}: ${docs.map((d: any) => d.unique_identifier).join(', ')}`, left, y);
      y += 16;
    }

    // Price
    y += 10;
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor(LINE).stroke();
    y += 12;
    const row = (label: string, value: string, bold = false) => {
      doc.fillColor(bold ? INK : MUTED).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10);
      doc.text(label, left, y);
      doc.text(value, left, y, { width, align: 'right' });
      y += bold ? 20 : 16;
    };
    if (order?.base_amount) row('Fare', money(order.base_amount, order.base_currency ?? order.total_currency));
    if (order?.tax_amount) row('Taxes and fees', money(order.tax_amount, order.tax_currency ?? order.total_currency));
    row('Total paid', money(order?.total_amount ?? 0, order?.total_currency ?? 'USD'), true);

    // Fare rules
    const c = order?.conditions ?? {};
    const rule = (label: string, r: any) => {
      if (!r) return `${label}: check with the airline`;
      if (!r.allowed) return `${label}: not allowed`;
      return r.penalty_amount && parseFloat(r.penalty_amount) > 0
        ? `${label}: allowed, fee ${money(r.penalty_amount, r.penalty_currency ?? order?.total_currency ?? 'USD')}`
        : `${label}: allowed, no fee`;
    };
    y += 8;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text('Fare rules', left, y);
    y += 16;
    doc.fillColor(MUTED).font('Helvetica').fontSize(9);
    doc.text(rule('Refund before departure', c.refund_before_departure), left, y);
    y += 13;
    doc.text(rule('Change before departure', c.change_before_departure), left, y);
    y += 13;
    if (order?.owner?.conditions_of_carriage_url) {
      doc.fillColor(BLUE).text('Airline conditions of carriage', left, y, {
        link: order.owner.conditions_of_carriage_url,
        underline: true,
      });
      y += 13;
    }

    doc
      .fillColor(MUTED)
      .fontSize(8)
      .text(
        'Times are local to each airport. Check in with the airline using your booking reference. ' +
          'Ticketed through Duffel on behalf of BlueMurr.',
        left,
        doc.page.height - 92,
        { width, align: 'center' },
      );

    doc.end();
  });
}
