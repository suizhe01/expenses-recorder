export type Rgb = readonly [number, number, number];
export type Oklab = readonly [number, number, number];
export type CvdType = 'deuteranope' | 'protanope' | 'tritanope';

export type PaletteInput = {
  surface: string;
  colors: readonly string[];
  other: string;
};

export type PaletteValidation = {
  passes: boolean;
  contrastPasses: boolean;
  chromaPasses: boolean;
  normalVisionPasses: boolean;
  cvdPasses: boolean;
};

export type PaletteMeasurements = {
  contrasts: number[];
  chromas: number[];
  normalDeltaEs: number[];
  cvdDeltaEs: Record<CvdType, number[]>;
};

const MIN_CONTRAST = 3;
const MIN_CHROMA = 0.08;
const MIN_NORMAL_DELTA_E = 15;
const MIN_CVD_DELTA_E = 6;

/** Parse the CSS colour syntax used by the theme tokens. */
export function parseColor(value: string): Rgb {
  const oklch = value.trim().match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.]+%?)?\)$/i);
  if (oklch) {
    return oklabToSrgb(oklchToOklab([Number(oklch[1]!), Number(oklch[2]!), Number(oklch[3]!)]));
  }

  const hex = value.trim().match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (hex) {
    return [Number.parseInt(hex[1]!, 16) / 255, Number.parseInt(hex[2]!, 16) / 255, Number.parseInt(hex[3]!, 16) / 255];
  }

  throw new Error(`Unsupported palette colour: ${value}`);
}

export function relativeLuminance(rgb: Rgb): number {
  const [red, green, blue] = rgb;
  return 0.2126 * srgbToLinear(red) + 0.7152 * srgbToLinear(green) + 0.0722 * srgbToLinear(blue);
}

export function contrastRatio(first: Rgb, second: Rgb): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

export function srgbToOklab([red, green, blue]: Rgb): Oklab {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklchToOklab([lightness, chroma, hue]: readonly [number, number, number]): Oklab {
  const radians = (hue * Math.PI) / 180;
  return [lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)];
}

export function oklabToSrgb([lightness, a, b]: Oklab): Rgb {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

export function deltaE(first: Oklab, second: Oklab): number {
  return 100 * Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

/**
 * The Brettel/Viénot dichromacy approximation in linear sRGB. Keeping the
 * matrices inline makes the palette check deterministic and dependency-free.
 */
export function simulateCvd(rgb: Rgb, type: CvdType): Rgb {
  const matrices: Record<CvdType, readonly (readonly [number, number, number])[]> = {
    protanope: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deuteranope: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
    tritanope: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
  };
  const linear: Rgb = [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
  const simulated = matrices[type].map(([r, g, b]) => clamp(r * linear[0] + g * linear[1] + b * linear[2]));
  return [linearToSrgb(simulated[0]!), linearToSrgb(simulated[1]!), linearToSrgb(simulated[2]!)];
}

export function validatePalette({ surface, colors, other }: PaletteInput): PaletteValidation {
  const surfaceRgb = parseColor(surface);
  const colorRgb = colors.map(parseColor);
  const allRgb = [...colorRgb, parseColor(other)];
  const contrastPasses = allRgb.every((color) => contrastRatio(color, surfaceRgb) >= MIN_CONTRAST);
  const chromaPasses = colorRgb.every((color) => {
    const [, a, b] = srgbToOklab(color);
    return Math.hypot(a, b) >= MIN_CHROMA;
  });
  const adjacent = colorRgb.slice(1).map((color, index) => [colorRgb[index]!, color] as const);
  const normalVisionPasses = adjacent.every(([first, second]) => deltaE(srgbToOklab(first), srgbToOklab(second)) >= MIN_NORMAL_DELTA_E);
  // A neutral categorical slot cannot carry identity under any CVD simulation.
  const cvdPasses = chromaPasses && (['deuteranope', 'protanope', 'tritanope'] as const).every((type) =>
    adjacent.every(([first, second]) => deltaE(srgbToOklab(simulateCvd(first, type)), srgbToOklab(simulateCvd(second, type))) >= MIN_CVD_DELTA_E),
  );
  return { passes: contrastPasses && chromaPasses && normalVisionPasses && cvdPasses, contrastPasses, chromaPasses, normalVisionPasses, cvdPasses };
}

export function measurePalette({ surface, colors, other }: PaletteInput): PaletteMeasurements {
  const surfaceRgb = parseColor(surface);
  const colorRgb = colors.map(parseColor);
  const allRgb = [...colorRgb, parseColor(other)];
  const adjacent = colorRgb.slice(1).map((color, index) => [colorRgb[index]!, color] as const);
  const cvdTypes: CvdType[] = ['deuteranope', 'protanope', 'tritanope'];
  return {
    contrasts: allRgb.map((color) => contrastRatio(color, surfaceRgb)),
    chromas: colorRgb.map((color) => {
      const [, a, b] = srgbToOklab(color);
      return Math.hypot(a, b);
    }),
    normalDeltaEs: adjacent.map(([first, second]) => deltaE(srgbToOklab(first), srgbToOklab(second))),
    cvdDeltaEs: Object.fromEntries(cvdTypes.map((type) => [type, adjacent.map(([first, second]) => deltaE(srgbToOklab(simulateCvd(first, type)), srgbToOklab(simulateCvd(second, type))))])) as Record<CvdType, number[]>,
  };
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
