export interface Coordinates {
  latitude: number;
  longitude: number;
}

const semiMajorAxis = 6378245;
const eccentricitySquared = 0.00669342162296594323;

// Bounds of the GCJ-02 offset of Apple Maps, as [north, west, south, east].
const shifted = [
  [49.2204, 79.4462, 42.8899, 96.33],
  [54.1415, 109.6872, 39.3742, 135.0002],
  [42.8899, 73.1246, 29.5297, 124.143255],
  [29.5297, 82.9684, 26.7186, 97.0352],
  [29.5297, 97.0253, 20.414096, 124.367395],
  [20.414096, 107.975793, 17.871542, 111.744104],
];
const unshifted = [
  [25.398623, 119.921265, 21.785006, 122.497559],
  [22.284, 101.8652, 20.0988, 106.665],
  [21.5422, 106.4525, 20.4878, 108.051],
  [55.8175, 109.0323, 50.3257, 119.127],
  [55.8175, 127.4568, 49.5574, 137.0227],
  [44.8922, 131.2662, 42.5692, 137.0227],
  // Hong Kong and Macau.
  [22.5, 113.8, 22.1, 114.45],
  [22.22, 113.52, 22.1, 113.6],
];

const within = (
  { latitude, longitude }: Coordinates,
  [north, west, south, east]: number[],
) =>
  latitude <= north &&
  latitude >= south &&
  longitude >= west &&
  longitude <= east;

const isShifted = (location: Coordinates) =>
  shifted.some((bounds) => within(location, bounds)) &&
  !unshifted.some((bounds) => within(location, bounds));

const offset = (x: number, y: number) => {
  const wave =
    ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  const latitude =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x)) +
    wave +
    ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3 +
    ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) *
      2) /
      3;
  const longitude =
    300 +
    x +
    2 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x)) +
    wave +
    ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3 +
    ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) *
      2) /
      3;
  return { latitude, longitude };
};

const shift = (wgs: Coordinates): Coordinates => {
  const { latitude, longitude } = offset(
    wgs.longitude - 105,
    wgs.latitude - 35,
  );
  const radians = (wgs.latitude / 180) * Math.PI;
  const sine = Math.sin(radians);
  const magic = 1 - eccentricitySquared * sine * sine;
  const root = Math.sqrt(magic);
  return {
    latitude:
      wgs.latitude +
      (latitude * 180) /
        (((semiMajorAxis * (1 - eccentricitySquared)) / (magic * root)) *
          Math.PI),
    longitude:
      wgs.longitude +
      (longitude * 180) /
        ((semiMajorAxis / root) * Math.cos(radians) * Math.PI),
  };
};

export const toGPS = (map: Coordinates): Coordinates => {
  if (!isShifted(map)) {
    return map;
  }
  let gps = map;
  for (let step = 0; step < 8; step++) {
    const moved = shift(gps);
    gps = {
      latitude: gps.latitude + map.latitude - moved.latitude,
      longitude: gps.longitude + map.longitude - moved.longitude,
    };
  }
  return gps;
};

export const toMap = (gps: Coordinates): Coordinates =>
  isShifted(gps) ? shift(gps) : gps;

export const parseCoordinates = (text: string): Coordinates | null => {
  const parts = text.trim().split(/[\s,，]+/);
  if (parts.length !== 2 || parts.includes("")) {
    return null;
  }
  const [latitude, longitude] = parts.map(Number);
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { latitude, longitude }
    : null;
};
