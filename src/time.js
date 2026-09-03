const TIME_ZONE = 'Asia/Kolkata';

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Renders `h:mm AM/PM` in IST, e.g. "2:51 PM". */
export function formatIstTime(date) {
  // Some ICU builds emit a narrow no-break space before AM/PM.
  return timeFormatter.format(date).replace(/ /g, ' ');
}

/** Renders `YYYY-MM-DD HH:mm` in IST, e.g. "2026-09-03 14:51". */
export function formatIstDateTime(date) {
  const parts = Object.fromEntries(
    dateTimeFormatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  // en-US with hour12:false renders midnight as "24"; normalise it to "00".
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}
