const LETTER_SOUNDS_AREA_LABEL = 'Kufundisha sauti za herufi';

const normalizeWhitespace = (value) => (
  value === null || value === undefined
    ? ''
    : String(value).replace(/\s+/g, ' ').trim()
);

const isLetterSoundsArea = (value) => {
  const cleaned = normalizeWhitespace(value);
  return /^kufundisha\s+sauti\s+za\s+herufi(?:\s*\([^)]*\))?$/i.test(cleaned);
};

const getCanonicalAreaOfFocusLabel = (value) => {
  const cleaned = normalizeWhitespace(value);
  if (!cleaned) return null;
  return isLetterSoundsArea(cleaned) ? LETTER_SOUNDS_AREA_LABEL : cleaned;
};

const normalizeAreaOfFocus = (value) => {
  const label = getCanonicalAreaOfFocusLabel(value);
  return label ? label.toLowerCase() : null;
};

const matchesAreaOfFocus = (candidate, targetNormalized) => {
  if (!targetNormalized) return true;
  return normalizeAreaOfFocus(candidate) === targetNormalized;
};

module.exports = {
  getCanonicalAreaOfFocusLabel,
  normalizeAreaOfFocus,
  matchesAreaOfFocus
};
