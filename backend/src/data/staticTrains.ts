/**
 * Static train lookup table for regions NOT covered by Deutsche Bahn's
 * v6.db.transport.rest API (primarily East Asia). Data is bidirectional —
 * storing `tokyo-osaka` also answers the `osaka-tokyo` case.
 *
 * Prices are approximate adult fares in USD (per passenger, 2026 estimates)
 * based on standard-class tickets at time of writing. Durations are the
 * fastest reliable service (e.g. Nozomi for Japanese shinkansen, KTX for
 * Korea). Use these as a "good enough" source until a real regional API
 * (JR, Korail, CR, etc.) is integrated.
 */

export type StaticTrainRoute = {
  /** Lowercase city name, one side of the pair. */
  from: string;
  /** Lowercase city name, other side of the pair. */
  to: string;
  /** Fastest typical journey time, minutes. */
  durationMinutes: number;
  /** Approximate adult standard-class fare in USD (already converted). */
  priceUsd: number;
  /** Rail operator shown in the UI. */
  operator: string;
  /** Product / service name (Nozomi, KTX, etc.). */
  trainType: string;
  /** Where to book — deep link or operator homepage. */
  bookingUrl: string;
};

const J_BOOK = 'https://smart-ex.jp/en/'; // JR SmartEX
const K_BOOK = 'https://www.letskorail.com/';
const C_BOOK = 'https://www.12306.cn/en/index.html';
const TW_BOOK = 'https://www.thsrc.com.tw/en/';

const routes: StaticTrainRoute[] = [
  // ─── Japan (shinkansen + key JR lines) ──────────────────────
  { from: 'tokyo', to: 'osaka',     durationMinutes: 140, priceUsd: 95,  operator: 'JR Central',  trainType: 'Nozomi shinkansen', bookingUrl: J_BOOK },
  { from: 'tokyo', to: 'kyoto',     durationMinutes: 130, priceUsd: 95,  operator: 'JR Central',  trainType: 'Nozomi shinkansen', bookingUrl: J_BOOK },
  { from: 'tokyo', to: 'nagoya',    durationMinutes: 100, priceUsd: 75,  operator: 'JR Central',  trainType: 'Nozomi shinkansen', bookingUrl: J_BOOK },
  { from: 'tokyo', to: 'hiroshima', durationMinutes: 240, priceUsd: 125, operator: 'JR Central',  trainType: 'Nozomi shinkansen', bookingUrl: J_BOOK },
  { from: 'tokyo', to: 'fukuoka',   durationMinutes: 300, priceUsd: 160, operator: 'JR Central',  trainType: 'Nozomi shinkansen', bookingUrl: J_BOOK },
  { from: 'tokyo', to: 'sendai',    durationMinutes: 95,  priceUsd: 75,  operator: 'JR East',     trainType: 'Hayabusa shinkansen', bookingUrl: J_BOOK },
  { from: 'tokyo', to: 'nagano',    durationMinutes: 90,  priceUsd: 60,  operator: 'JR East',     trainType: 'Hokuriku shinkansen', bookingUrl: J_BOOK },
  { from: 'tokyo', to: 'kanazawa',  durationMinutes: 150, priceUsd: 95,  operator: 'JR East',     trainType: 'Hokuriku shinkansen', bookingUrl: J_BOOK },
  { from: 'tokyo', to: 'hakone',    durationMinutes: 90,  priceUsd: 15,  operator: 'Odakyu',      trainType: 'Romance Car', bookingUrl: 'https://www.odakyu.jp/english/romancecar/' },
  { from: 'tokyo', to: 'nikko',     durationMinutes: 110, priceUsd: 20,  operator: 'Tobu Railway', trainType: 'Spacia limited express', bookingUrl: 'https://www.tobu.co.jp/foreign/en/' },
  { from: 'tokyo', to: 'sapporo',   durationMinutes: 480, priceUsd: 200, operator: 'JR East/Hokkaido', trainType: 'Hokkaido shinkansen (+transfer)', bookingUrl: J_BOOK },
  { from: 'tokyo', to: 'nara',      durationMinutes: 180, priceUsd: 100, operator: 'JR Central',  trainType: 'Shinkansen + local', bookingUrl: J_BOOK },
  { from: 'tokyo', to: 'yokohama',  durationMinutes: 30,  priceUsd: 5,   operator: 'JR East',     trainType: 'Tokaido line',  bookingUrl: J_BOOK },

  { from: 'osaka', to: 'kyoto',     durationMinutes: 15,  priceUsd: 5,   operator: 'JR West',     trainType: 'Special Rapid', bookingUrl: J_BOOK },
  { from: 'osaka', to: 'nagoya',    durationMinutes: 50,  priceUsd: 45,  operator: 'JR Central',  trainType: 'Nozomi shinkansen', bookingUrl: J_BOOK },
  { from: 'osaka', to: 'hiroshima', durationMinutes: 85,  priceUsd: 65,  operator: 'JR West',     trainType: 'Nozomi shinkansen', bookingUrl: J_BOOK },
  { from: 'osaka', to: 'fukuoka',   durationMinutes: 150, priceUsd: 100, operator: 'JR West',     trainType: 'Nozomi shinkansen', bookingUrl: J_BOOK },
  { from: 'osaka', to: 'nara',      durationMinutes: 45,  priceUsd: 5,   operator: 'JR West',     trainType: 'Yamatoji rapid', bookingUrl: J_BOOK },
  { from: 'osaka', to: 'kobe',      durationMinutes: 30,  priceUsd: 5,   operator: 'JR West',     trainType: 'Special Rapid', bookingUrl: J_BOOK },

  { from: 'kyoto', to: 'nara',      durationMinutes: 45,  priceUsd: 5,   operator: 'JR West',     trainType: 'Miyakoji rapid', bookingUrl: J_BOOK },
  { from: 'kyoto', to: 'nagoya',    durationMinutes: 35,  priceUsd: 45,  operator: 'JR Central',  trainType: 'Nozomi shinkansen', bookingUrl: J_BOOK },
  { from: 'kyoto', to: 'hiroshima', durationMinutes: 100, priceUsd: 75,  operator: 'JR West',     trainType: 'Nozomi shinkansen', bookingUrl: J_BOOK },
  { from: 'kyoto', to: 'kanazawa',  durationMinutes: 135, priceUsd: 65,  operator: 'JR West',     trainType: 'Thunderbird limited express', bookingUrl: J_BOOK },

  { from: 'hiroshima', to: 'fukuoka', durationMinutes: 70, priceUsd: 70, operator: 'JR West',    trainType: 'Nozomi shinkansen', bookingUrl: J_BOOK },

  // ─── South Korea (KTX + SRT) ─────────────────────────────────
  { from: 'seoul',  to: 'busan',   durationMinutes: 160, priceUsd: 50, operator: 'Korail',  trainType: 'KTX', bookingUrl: K_BOOK },
  { from: 'seoul',  to: 'daegu',   durationMinutes: 100, priceUsd: 40, operator: 'Korail',  trainType: 'KTX', bookingUrl: K_BOOK },
  { from: 'seoul',  to: 'gwangju', durationMinutes: 110, priceUsd: 35, operator: 'Korail',  trainType: 'KTX', bookingUrl: K_BOOK },
  { from: 'seoul',  to: 'gyeongju',durationMinutes: 130, priceUsd: 45, operator: 'Korail',  trainType: 'KTX', bookingUrl: K_BOOK },
  { from: 'seoul',  to: 'incheon', durationMinutes: 60,  priceUsd: 8,  operator: 'Korail',  trainType: 'Airport railroad', bookingUrl: K_BOOK },
  { from: 'busan',  to: 'daegu',   durationMinutes: 50,  priceUsd: 18, operator: 'Korail',  trainType: 'KTX', bookingUrl: K_BOOK },
  { from: 'busan',  to: 'gyeongju',durationMinutes: 30,  priceUsd: 8,  operator: 'Korail',  trainType: 'KTX', bookingUrl: K_BOOK },

  // ─── Mainland China (CR / CRH high-speed) ───────────────────
  { from: 'beijing',  to: 'shanghai', durationMinutes: 270, priceUsd: 80, operator: 'China Railway', trainType: 'G-series HSR', bookingUrl: C_BOOK },
  { from: 'beijing',  to: 'xian',     durationMinutes: 270, priceUsd: 80, operator: 'China Railway', trainType: 'G-series HSR', bookingUrl: C_BOOK },
  { from: 'shanghai', to: 'hangzhou', durationMinutes: 45,  priceUsd: 12, operator: 'China Railway', trainType: 'G-series HSR', bookingUrl: C_BOOK },
  { from: 'shanghai', to: 'suzhou',   durationMinutes: 25,  priceUsd: 8,  operator: 'China Railway', trainType: 'G-series HSR', bookingUrl: C_BOOK },
  { from: 'shanghai', to: 'nanjing',  durationMinutes: 75,  priceUsd: 25, operator: 'China Railway', trainType: 'G-series HSR', bookingUrl: C_BOOK },
  { from: 'guangzhou',to: 'shenzhen', durationMinutes: 35,  priceUsd: 15, operator: 'China Railway', trainType: 'G-series HSR', bookingUrl: C_BOOK },
  { from: 'guangzhou',to: 'hongkong', durationMinutes: 50,  priceUsd: 30, operator: 'China Railway/MTR', trainType: 'Guangzhou-HK HSR', bookingUrl: C_BOOK },

  // ─── Taiwan HSR ─────────────────────────────────────────────
  { from: 'taipei', to: 'kaohsiung', durationMinutes: 95, priceUsd: 45, operator: 'Taiwan HSR', trainType: 'THSR', bookingUrl: TW_BOOK },
  { from: 'taipei', to: 'taichung',  durationMinutes: 50, priceUsd: 22, operator: 'Taiwan HSR', trainType: 'THSR', bookingUrl: TW_BOOK },
  { from: 'taipei', to: 'tainan',    durationMinutes: 85, priceUsd: 40, operator: 'Taiwan HSR', trainType: 'THSR', bookingUrl: TW_BOOK },

  // ─── India ──────────────────────────────────────────────────
  { from: 'delhi',   to: 'agra',   durationMinutes: 100, priceUsd: 15, operator: 'Indian Railways', trainType: 'Gatimaan Express', bookingUrl: 'https://www.irctc.co.in/' },
  { from: 'delhi',   to: 'jaipur', durationMinutes: 280, priceUsd: 18, operator: 'Indian Railways', trainType: 'Shatabdi Express', bookingUrl: 'https://www.irctc.co.in/' },
  { from: 'mumbai',  to: 'pune',   durationMinutes: 210, priceUsd: 12, operator: 'Indian Railways', trainType: 'Deccan Express', bookingUrl: 'https://www.irctc.co.in/' },
];

/**
 * Look up a train route in the static table. Returns undefined if the pair
 * isn't in the table (caller should then fall back to DB REST).
 *
 * Matching is:
 * - Case-insensitive
 * - Trimmed
 * - Bidirectional (tokyo↔osaka works as either from/to)
 * - Tolerant of minor spelling variants we explicitly map (kyoto ≡ kyōto).
 */
export function getStaticTrain(originRaw: string, destinationRaw: string): StaticTrainRoute | undefined {
  const normalize = (s: string): string =>
    s
      .toLowerCase()
      .trim()
      .replace(/[ō]/g, 'o')
      .replace(/[ū]/g, 'u')
      .replace(/[ā]/g, 'a')
      .replace(/[ē]/g, 'e')
      .replace(/[ī]/g, 'i')
      .replace(/\s+/g, '')
      .replace(/city$/, '');

  // Hand-picked aliases for common alternate spellings.
  const ALIASES: Record<string, string> = {
    hakata: 'fukuoka',          // Hakata is the shinkansen terminus in Fukuoka
    sapporojp: 'sapporo',
    xian: 'xian',
    xi_an: 'xian',
    hongkong: 'hongkong',
    hk: 'hongkong',
    nycitypj: 'nagoya',          // guard typos
  };

  const dealias = (s: string): string => ALIASES[s] ?? s;

  const origin = dealias(normalize(originRaw));
  const destination = dealias(normalize(destinationRaw));
  if (!origin || !destination || origin === destination) return undefined;

  return routes.find(
    (r) =>
      (r.from === origin && r.to === destination) ||
      (r.from === destination && r.to === origin),
  );
}
