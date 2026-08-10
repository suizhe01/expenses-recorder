import { describe, expect, it } from 'vitest';
import { BOM, centsCell, csvRow, plainCell, textCell, timestampCell } from '../csv.js';

/** EXP-20. The cell helpers, with no database or HTTP in the way. */

describe('AC-5: centsCell', () => {
  it('renders integer cents as two decimal places', () => {
    expect(centsCell(14930)).toBe('149.30');
    expect(centsCell(2685)).toBe('26.85');
  });

  it('keeps a leading zero for amounts under one unit', () => {
    expect(centsCell(5)).toBe('0.05');
    expect(centsCell(50)).toBe('0.50');
  });

  it('renders zero as 0.00 rather than an empty cell', () => {
    // Distinguishable from null: a recorded zero tax is not a missing one.
    expect(centsCell(0)).toBe('0.00');
  });

  it('renders a negative rounding with the sign outside the digits', () => {
    expect(centsCell(-2)).toBe('-0.02');
    expect(centsCell(-150)).toBe('-1.50');
  });

  it('AC-6: renders null as an empty cell', () => {
    expect(centsCell(null)).toBe('');
  });
});

describe('AC-9: quoting', () => {
  it('leaves an ordinary value bare', () => {
    expect(plainCell('MYR')).toBe('MYR');
    expect(textCell('Master Prawn Mee')).toBe('Master Prawn Mee');
  });

  it('quotes a value containing a comma', () => {
    expect(textCell('Kuala Lumpur, Malaysia')).toBe('"Kuala Lumpur, Malaysia"');
  });

  it('doubles an embedded double quote', () => {
    expect(textCell('the "usual" order')).toBe('"the ""usual"" order"');
  });

  it('quotes a value containing a newline so it stays one record', () => {
    expect(textCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('AC-6: renders null and empty alike as an empty cell', () => {
    expect(textCell(null)).toBe('');
    expect(textCell('')).toBe('');
    expect(plainCell(null)).toBe('');
  });

  it('terminates a record with CRLF', () => {
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });
});

describe('AC-10: the formula guard', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])(
    'guards a text cell starting with %j',
    (leader) => {
      const guarded = textCell(`${leader}danger`);

      expect(guarded.startsWith(`"'${leader}`)).toBe(true);
    },
  );

  it('neutralises a real formula payload', () => {
    expect(textCell('=HYPERLINK("http://evil","x")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""x"")"',
    );
  });

  it('leaves a negative amount as a number a spreadsheet can sum', () => {
    // The whole reason the guard is on textCell rather than on every cell:
    // "'-0.02" would no longer add up.
    expect(centsCell(-2)).toBe('-0.02');
    expect(plainCell('-0.02')).toBe('-0.02');
  });

  it('does not guard a leader that appears later in the value', () => {
    expect(textCell('2+2 Cafe')).toBe('2+2 Cafe');
  });
});

describe('AC-7: timestampCell', () => {
  /**
   * The instant is chosen so UTC and Malaysian time fall on *different days*:
   * 18:31Z is 02:31 the next morning in Kuala Lumpur. A renderer that reported
   * UTC would say the 8th here, which is the whole bug being guarded against.
   */
  it('renders a timestamptz in Malaysian time', () => {
    expect(timestampCell(new Date('2026-08-08T18:31:07.412Z'))).toBe(
      '2026-08-09 02:31:07',
    );
  });

  it('drops sub-second precision without rounding the second up', () => {
    expect(timestampCell(new Date('2026-08-08T18:31:07.999Z'))).toBe(
      '2026-08-09 02:31:07',
    );
  });

  /**
   * The suite is pinned to Asia/Kuala_Lumpur and the container to UTC, so a
   * formatter that read the process timezone would make CI and production
   * disagree about what a receipt says. Forcing TZ both ways here is what makes
   * that a test failure rather than a deployment surprise.
   */
  it('gives the same answer whatever the process timezone is', () => {
    const at = new Date('2026-08-08T18:31:07.412Z');
    const original = process.env.TZ;

    try {
      process.env.TZ = 'UTC';
      const utc = timestampCell(at);

      process.env.TZ = 'America/New_York';
      const newYork = timestampCell(at);

      process.env.TZ = 'Asia/Kuala_Lumpur';
      const malaysia = timestampCell(at);

      expect(utc).toBe('2026-08-09 02:31:07');
      expect(newYork).toBe(utc);
      expect(malaysia).toBe(utc);
    } finally {
      process.env.TZ = original;
    }
  });
});

describe('AC-8: the byte-order mark', () => {
  it('is the three bytes Excel sniffs for', () => {
    expect(Buffer.from(BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});
