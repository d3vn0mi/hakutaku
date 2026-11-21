// Angles and magnitudes as astronomers write them, in plain ASCII.

const pad = (n: number): string => String(n).padStart(2, "0");

// Splits a non-negative value into whole units, sixtieths and 3600ths, rounding the last.
function sexagesimal(value: number): [number, number, number] {
  let whole = Math.floor(value);
  let minutes = Math.floor((value - whole) * 60);
  let seconds = Math.round(((value - whole) * 60 - minutes) * 60);
  if (seconds === 60) {
    seconds = 0;
    minutes++;
  }
  if (minutes === 60) {
    minutes = 0;
    whole++;
  }
  return [whole, minutes, seconds];
}

// Right ascension in degrees as hours, minutes and seconds: 101.287 is "06h 45m 09s".
export function formatRightAscension(degrees: number): string {
  const hours = (((degrees % 360) + 360) % 360) / 15;
  const [h, m, s] = sexagesimal(hours);
  return `${pad(h % 24)}h ${pad(m)}m ${pad(s)}s`;
}

// Declination in degrees, with its sign: -16.716 is "-16d 42m 58s".
export function formatDeclination(degrees: number): string {
  const [d, m, s] = sexagesimal(Math.abs(degrees));
  return `${degrees < 0 ? "-" : "+"}${pad(d)}d ${pad(m)}m ${pad(s)}s`;
}

// A visual magnitude with its sign and two decimals: "-1.46 mag", "+0.03 mag".
export function formatMagnitude(magnitude: number): string {
  return `${magnitude < 0 ? "-" : "+"}${Math.abs(magnitude).toFixed(2)} mag`;
}
