// Calendar dates for the showroom's business day (India time). Using
// toISOString() instead gives UTC, which is still "yesterday" before 05:30 IST.
const IST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })

/** YYYY-MM-DD in India time, for date inputs and same-day comparisons. */
export function istDate(value: Date | string | number = new Date()) {
  return IST_DATE.format(new Date(value))
}

/** First day of the current IST month as YYYY-MM-DD. */
export function istMonthStart(value: Date | string | number = new Date()) {
  return `${istDate(value).slice(0, 7)}-01`
}
