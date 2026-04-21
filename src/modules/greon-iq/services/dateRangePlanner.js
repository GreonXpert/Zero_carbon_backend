'use strict';

// ============================================================================
// dateRangePlanner.js — Parses date expressions into concrete date ranges (IST)
//
// All date math uses Asia/Kolkata timezone to align with the reporting calendar
// and the IST-based quota reset schedule.
//
// Returned shape:
//   { label, startDate, endDate, reportingBasis }
//   where startDate and endDate are JavaScript Date objects (UTC-stored)
//
// Expressions supported:
//   'last_month', 'this_month', 'last_quarter', 'current_quarter',
//   'year_to_date', 'last_year', 'last_week', 'this_week',
//   { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }  — custom range
//   'YYYY-MM'  — specific month
//   'YYYY-QN'  — specific quarter (Q1-Q4)
// ============================================================================

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Convert a local IST wall-clock date (midnight IST) to a UTC Date object.
 * @param {number} year
 * @param {number} month  1-based
 * @param {number} day
 * @returns {Date}
 */
function istToUtc(year, month, day) {
  // Construct as if UTC, then subtract IST offset to get correct UTC equivalent
  const utcMs = Date.UTC(year, month - 1, day) - IST_OFFSET_MS;
  return new Date(utcMs);
}

/**
 * Get the current date in IST as a plain object { year, month, day }.
 */
function nowIST() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return {
    year:  ist.getFullYear(),
    month: ist.getMonth() + 1, // 1-based
    day:   ist.getDate(),
  };
}

/**
 * Resolve a date expression to a concrete date range.
 * @param {string|object} expression
 * @returns {{ label: string, startDate: Date, endDate: Date, reportingBasis: string }|null}
 */
function resolveDateRange(expression) {
  if (!expression) return null;

  const n = nowIST();

  // ── String expressions ────────────────────────────────────────────────────
  if (typeof expression === 'string') {
    const expr = expression.toLowerCase().replace(/[\s-]/g, '_');

    if (expr === 'this_month') {
      return {
        label:          'This Month',
        startDate:      istToUtc(n.year, n.month, 1),
        endDate:        new Date(),
        reportingBasis: 'calendar',
      };
    }

    if (expr === 'last_month') {
      const lm = n.month === 1
        ? { year: n.year - 1, month: 12 }
        : { year: n.year,     month: n.month - 1 };
      const lastDay = new Date(Date.UTC(lm.year, lm.month, 0)).getUTCDate();
      return {
        label:          'Last Month',
        startDate:      istToUtc(lm.year, lm.month, 1),
        endDate:        istToUtc(lm.year, lm.month, lastDay),
        reportingBasis: 'calendar',
      };
    }

    if (expr === 'current_quarter' || expr === 'this_quarter') {
      const qStart = Math.floor((n.month - 1) / 3) * 3 + 1;
      return {
        label:          'Current Quarter',
        startDate:      istToUtc(n.year, qStart, 1),
        endDate:        new Date(),
        reportingBasis: 'calendar',
      };
    }

    if (expr === 'last_quarter') {
      const currentQStart = Math.floor((n.month - 1) / 3) * 3 + 1;
      let lqStart = currentQStart - 3;
      let lqYear  = n.year;
      if (lqStart < 1) { lqStart += 12; lqYear -= 1; }
      const lqEnd   = lqStart + 2;
      const lastDay = new Date(Date.UTC(lqYear, lqEnd, 0)).getUTCDate();
      return {
        label:          'Last Quarter',
        startDate:      istToUtc(lqYear, lqStart, 1),
        endDate:        istToUtc(lqYear, lqEnd,   lastDay),
        reportingBasis: 'calendar',
      };
    }

    if (expr === 'year_to_date' || expr === 'ytd') {
      return {
        label:          'Year to Date',
        startDate:      istToUtc(n.year, 1, 1),
        endDate:        new Date(),
        reportingBasis: 'calendar',
      };
    }

    if (expr === 'last_year') {
      return {
        label:          'Last Year',
        startDate:      istToUtc(n.year - 1, 1,  1),
        endDate:        istToUtc(n.year - 1, 12, 31),
        reportingBasis: 'calendar',
      };
    }

    if (expr === 'this_week') {
      const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const day = ist.getDay() || 7;
      const monday = new Date(ist);
      monday.setDate(ist.getDate() - day + 1);
      return {
        label:          'This Week',
        startDate:      istToUtc(monday.getFullYear(), monday.getMonth() + 1, monday.getDate()),
        endDate:        new Date(),
        reportingBasis: 'calendar',
      };
    }

    if (expr === 'last_week') {
      const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const day = ist.getDay() || 7;
      const lastMonday = new Date(ist);
      lastMonday.setDate(ist.getDate() - day + 1 - 7);
      const lastSunday = new Date(lastMonday);
      lastSunday.setDate(lastMonday.getDate() + 6);
      return {
        label:          'Last Week',
        startDate:      istToUtc(lastMonday.getFullYear(), lastMonday.getMonth() + 1, lastMonday.getDate()),
        endDate:        istToUtc(lastSunday.getFullYear(), lastSunday.getMonth() + 1, lastSunday.getDate()),
        reportingBasis: 'calendar',
      };
    }

    // 'YYYY-MM' — specific month
    const monthMatch = expr.match(/^(\d{4})[_-](\d{1,2})$/);
    if (monthMatch) {
      const yr = parseInt(monthMatch[1], 10);
      const mo = parseInt(monthMatch[2], 10);
      const lastDay = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
      return {
        label:          `${yr}-${String(mo).padStart(2, '0')}`,
        startDate:      istToUtc(yr, mo, 1),
        endDate:        istToUtc(yr, mo, lastDay),
        reportingBasis: 'calendar',
      };
    }

    // 'YYYY-QN' — specific quarter
    const qMatch = expr.match(/^(\d{4})[_-]q(\d)$/);
    if (qMatch) {
      const yr      = parseInt(qMatch[1], 10);
      const q       = parseInt(qMatch[2], 10);
      const qStart  = (q - 1) * 3 + 1;
      const qEnd    = qStart + 2;
      const lastDay = new Date(Date.UTC(yr, qEnd, 0)).getUTCDate();
      return {
        label:          `${yr} Q${q}`,
        startDate:      istToUtc(yr, qStart, 1),
        endDate:        istToUtc(yr, qEnd,   lastDay),
        reportingBasis: 'calendar',
      };
    }
  }

  // ── Object custom range { from, to } ──────────────────────────────────────
  if (typeof expression === 'object' && expression.from && expression.to) {
    const [sy, sm, sd] = expression.from.split('-').map(Number);
    const [ey, em, ed] = expression.to.split('-').map(Number);
    return {
      label:          `${expression.from} to ${expression.to}`,
      startDate:      istToUtc(sy, sm, sd),
      endDate:        istToUtc(ey, em, ed),
      reportingBasis: 'custom',
    };
  }

  return null;
}

/**
 * Extract a date range expression from a user question using keyword matching.
 * Returns an expression string or null if no match.
 * @param {string} question
 * @returns {string|null}
 */
function detectDateExpression(question) {
  const q = question.toLowerCase();

  if (/last\s*month/.test(q))                        return 'last_month';
  if (/this\s*month|current\s*month/.test(q))        return 'this_month';
  if (/last\s*quarter/.test(q))                      return 'last_quarter';
  if (/this\s*quarter|current\s*quarter/.test(q))    return 'current_quarter';
  if (/year.to.date|ytd/.test(q))                    return 'year_to_date';
  if (/last\s*year/.test(q))                         return 'last_year';
  if (/last\s*week/.test(q))                         return 'last_week';
  if (/this\s*week|current\s*week/.test(q))          return 'this_week';

  // Specific month: "March 2026", "march 2026", "2026-03"
  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  for (let i = 0; i < monthNames.length; i++) {
    const reg = new RegExp(`${monthNames[i]}\\s+(\\d{4})`);
    const m = q.match(reg);
    if (m) return `${m[1]}-${String(i + 1).padStart(2, '0')}`;
  }

  // YYYY-MM pattern
  const ym = q.match(/\b(\d{4})-(\d{2})\b/);
  if (ym) return `${ym[1]}-${ym[2]}`;

  // Quarter: "Q1 2026", "2026 Q2"
  const qp = q.match(/\bq([1-4])\s+(\d{4})\b|\b(\d{4})\s+q([1-4])\b/i);
  if (qp) {
    const qi = qp[1] || qp[4];
    const yr = qp[2] || qp[3];
    return `${yr}-Q${qi}`;
  }

  return null;
}

module.exports = { resolveDateRange, detectDateExpression };
