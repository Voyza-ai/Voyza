import { Trip, City, Transport, Hotel, Restaurant, Vibe } from '@/lib/types';

/**
 * Curated preset itineraries for the Browse marketplace. Four hand-built
 * trips spanning different scopes — one country, a multi-country rail
 * circuit, a region hop, and a continent tour.
 *
 * Dates are NOT stored here: `buildPresetTrip()` stamps a rolling start
 * date (~1 month out) at click time so a preset opened in November gets
 * December dates, not stale hardcoded ones. The builder returns a full
 * `Trip` payload compatible with saveTrip() → canvas, so "Edit in Canvas"
 * behaves exactly like a trip the user planned themselves.
 */

export type PresetCity = {
  name: string;
  country: string;
  nights: number;
  hotel: Hotel;
  activities: string[];
  restaurants: Restaurant[];
  vibes: Vibe[];
  /** Transport to the NEXT city — omit on the last city. */
  transportOut?: Transport;
};

export type PresetItinerary = {
  slug: string;
  title: string;
  tagline: string;
  description: string;
  /** Card banner gradient (same visual language as history cards). */
  coverGradient: string;
  /** Emoji flags shown on the card — quick read of countries covered. */
  flags: string;
  /** "One country" / "5 countries" / "Continent" chip. */
  scope: string;
  travelers: number;
  cities: PresetCity[];
};

const t = (
  mode: 'flight' | 'train',
  operator: string,
  duration: string,
  price: number,
): Transport => ({ mode, operator, duration, price });

export const PRESET_ITINERARIES: PresetItinerary[] = [
  {
    slug: 'japan-golden-route',
    title: 'Japan Golden Route',
    tagline: 'Neon Tokyo to temple-lined Kyoto — the classic first Japan trip.',
    description:
      'The definitive introduction to Japan: four days soaking in Tokyo\'s energy, a hot-spring night under Mt. Fuji in Hakone, Kyoto\'s shrines and bamboo groves, and Osaka\'s legendary street food to finish. All connected by bullet train.',
    coverGradient: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    flags: '🇯🇵',
    scope: 'One country',
    travelers: 2,
    cities: [
      {
        name: 'Tokyo',
        country: 'Japan',
        nights: 3,
        hotel: { name: 'Hotel Gracery Shinjuku', rating: 8.7, pricePerNight: 148, area: 'Shinjuku' },
        activities: [
          'Shibuya Crossing at golden hour',
          'TeamLab Planets digital art museum',
          'Senso-ji Temple and Asakusa old town',
          'Tsukiji Outer Market breakfast crawl',
        ],
        restaurants: [
          { name: 'Ichiran Shibuya', cuisine: 'Ramen', priceRange: '$' },
          { name: 'Sushi no Midori', cuisine: 'Sushi', priceRange: '$$' },
        ],
        vibes: ['city', 'food'],
        transportOut: t('train', 'Odakyu Romancecar', '1h 25m', 18),
      },
      {
        name: 'Hakone',
        country: 'Japan',
        nights: 1,
        hotel: { name: 'Hakone Kowakien Ten-yu', rating: 9.0, pricePerNight: 310, area: 'Kowakudani' },
        activities: [
          'Open-air onsen with Mt. Fuji views',
          'Hakone Ropeway over Owakudani valley',
          'Pirate ship cruise on Lake Ashi',
        ],
        restaurants: [
          { name: 'Itoh Dining by Nobu', cuisine: 'Teppanyaki', priceRange: '$$$' },
        ],
        vibes: ['nature', 'romance'],
        transportOut: t('train', 'Shinkansen Hikari', '2h 40m', 74),
      },
      {
        name: 'Kyoto',
        country: 'Japan',
        nights: 3,
        hotel: { name: 'The Royal Park Hotel Kyoto Sanjo', rating: 8.8, pricePerNight: 132, area: 'Sanjo' },
        activities: [
          'Fushimi Inari 10,000 torii gates at dawn',
          'Arashiyama Bamboo Grove and monkey park',
          'Kinkaku-ji (Golden Pavilion)',
          'Gion evening walk — geisha district',
        ],
        restaurants: [
          { name: 'Nishiki Warai', cuisine: 'Okonomiyaki', priceRange: '$' },
          { name: 'Gion Karyo', cuisine: 'Kaiseki', priceRange: '$$$' },
        ],
        vibes: ['history', 'art'],
        transportOut: t('train', 'JR Special Rapid', '0h 29m', 5),
      },
      {
        name: 'Osaka',
        country: 'Japan',
        nights: 2,
        hotel: { name: 'Cross Hotel Osaka', rating: 8.9, pricePerNight: 121, area: 'Namba' },
        activities: [
          'Dotonbori neon river walk',
          'Osaka Castle and surrounding park',
          'Kuromon Ichiba market grazing',
        ],
        restaurants: [
          { name: 'Mizuno Dotonbori', cuisine: 'Okonomiyaki', priceRange: '$$' },
          { name: 'Harukoma Sushi', cuisine: 'Sushi', priceRange: '$' },
        ],
        vibes: ['food', 'nightlife'],
      },
    ],
  },
  {
    slug: 'imperial-europe-rail',
    title: 'Imperial Europe by Rail',
    tagline: 'Five capitals, five countries, zero airports.',
    description:
      'A grand old-world circuit stitched together entirely by high-speed rail: Paris\'s museums, Amsterdam\'s canals, Berlin\'s history, Prague\'s fairytale old town, and Vienna\'s coffee-house grandeur. Watch Europe change out the train window.',
    coverGradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    flags: '🇫🇷 🇳🇱 🇩🇪 🇨🇿 🇦🇹',
    scope: '5 countries',
    travelers: 2,
    cities: [
      {
        name: 'Paris',
        country: 'France',
        nights: 3,
        hotel: { name: 'Hôtel Malte Opéra', rating: 8.6, pricePerNight: 189, area: '2nd Arrondissement' },
        activities: [
          'Louvre early-entry morning',
          'Seine walk from Notre-Dame to the Eiffel Tower',
          'Montmartre and Sacré-Cœur at sunset',
        ],
        restaurants: [
          { name: 'Bouillon Chartier', cuisine: 'French', priceRange: '$' },
          { name: 'Le Comptoir du Relais', cuisine: 'Bistro', priceRange: '$$' },
        ],
        vibes: ['art', 'romance'],
        transportOut: t('train', 'Eurostar', '3h 20m', 79),
      },
      {
        name: 'Amsterdam',
        country: 'Netherlands',
        nights: 2,
        hotel: { name: 'Hotel V Nesplein', rating: 8.8, pricePerNight: 176, area: 'City Centre' },
        activities: [
          'Canal ring bike loop',
          'Van Gogh Museum',
          'Jordaan neighborhood café crawl',
        ],
        restaurants: [
          { name: 'Foodhallen', cuisine: 'Food hall', priceRange: '$$' },
          { name: 'The Pancake Bakery', cuisine: 'Dutch', priceRange: '$' },
        ],
        vibes: ['city', 'art'],
        transportOut: t('train', 'Deutsche Bahn ICE', '6h 20m', 60),
      },
      {
        name: 'Berlin',
        country: 'Germany',
        nights: 2,
        hotel: { name: 'Hotel AMANO Grand Central', rating: 8.5, pricePerNight: 124, area: 'Mitte' },
        activities: [
          'East Side Gallery — the painted Wall',
          'Museum Island afternoon',
          'Brandenburg Gate and Reichstag dome',
        ],
        restaurants: [
          { name: 'Mustafa\'s Gemüse Kebap', cuisine: 'Street food', priceRange: '$' },
          { name: 'Zur letzten Instanz', cuisine: 'German', priceRange: '$$' },
        ],
        vibes: ['history', 'nightlife'],
        transportOut: t('train', 'EC Berliner', '4h 15m', 39),
      },
      {
        name: 'Prague',
        country: 'Czechia',
        nights: 2,
        hotel: { name: 'Hotel Golden Key', rating: 9.1, pricePerNight: 142, area: 'Malá Strana' },
        activities: [
          'Charles Bridge before the crowds',
          'Prague Castle and St. Vitus Cathedral',
          'Old Town Square astronomical clock',
        ],
        restaurants: [
          { name: 'Lokál Dlouhá', cuisine: 'Czech', priceRange: '$' },
          { name: 'Café Savoy', cuisine: 'Café', priceRange: '$$' },
        ],
        vibes: ['history', 'romance'],
        transportOut: t('train', 'ÖBB Railjet', '4h 0m', 29),
      },
      {
        name: 'Vienna',
        country: 'Austria',
        nights: 2,
        hotel: { name: 'Hotel Motto', rating: 8.9, pricePerNight: 168, area: 'Mariahilf' },
        activities: [
          'Schönbrunn Palace gardens',
          'Kunsthistorisches Museum',
          'Classical concert at Musikverein',
        ],
        restaurants: [
          { name: 'Figlmüller', cuisine: 'Schnitzel', priceRange: '$$' },
          { name: 'Café Central', cuisine: 'Coffee house', priceRange: '$$' },
        ],
        vibes: ['art', 'history'],
      },
    ],
  },
  {
    slug: 'southeast-asia-adventure',
    title: 'Southeast Asia Adventure',
    tagline: 'Temples, street food, and lantern-lit nights across three countries.',
    description:
      'Bangkok\'s controlled chaos, the ancient temple city of Angkor, Hanoi\'s old-quarter buzz, and the lantern-lit riverside of Hoi An. Maximum flavor per dollar — this route runs on street food and wonder.',
    coverGradient: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
    flags: '🇹🇭 🇰🇭 🇻🇳',
    scope: '3 countries',
    travelers: 2,
    cities: [
      {
        name: 'Bangkok',
        country: 'Thailand',
        nights: 3,
        hotel: { name: 'Ibis Styles Bangkok Sukhumvit', rating: 8.3, pricePerNight: 54, area: 'Sukhumvit' },
        activities: [
          'Grand Palace and Wat Pho reclining Buddha',
          'Chao Phraya river ferry hop',
          'Chatuchak weekend market',
          'Rooftop sunset at Mahanakhon SkyWalk',
        ],
        restaurants: [
          { name: 'Jay Fai', cuisine: 'Street food', priceRange: '$$' },
          { name: 'Thipsamai Pad Thai', cuisine: 'Thai', priceRange: '$' },
        ],
        vibes: ['food', 'city'],
        transportOut: t('flight', 'Bangkok Airways', '1h 5m', 96),
      },
      {
        name: 'Siem Reap',
        country: 'Cambodia',
        nights: 2,
        hotel: { name: 'Golden Temple Hotel', rating: 9.2, pricePerNight: 48, area: 'Old French Quarter' },
        activities: [
          'Angkor Wat sunrise',
          'Ta Prohm — the tree-swallowed temple',
          'Bayon\'s two hundred stone faces',
        ],
        restaurants: [
          { name: 'Malis Restaurant', cuisine: 'Khmer', priceRange: '$$' },
          { name: 'Pub Street night market', cuisine: 'Street food', priceRange: '$' },
        ],
        vibes: ['history', 'nature'],
        transportOut: t('flight', 'Vietnam Airlines', '1h 45m', 118),
      },
      {
        name: 'Hanoi',
        country: 'Vietnam',
        nights: 2,
        hotel: { name: 'La Siesta Classic Ma May', rating: 9.3, pricePerNight: 62, area: 'Old Quarter' },
        activities: [
          'Old Quarter walking food tour',
          'Hoan Kiem Lake at dawn — tai chi hour',
          'Train Street café',
        ],
        restaurants: [
          { name: 'Bún Chả Hương Liên', cuisine: 'Vietnamese', priceRange: '$' },
          { name: 'Giảng Café', cuisine: 'Egg coffee', priceRange: '$' },
        ],
        vibes: ['food', 'history'],
        transportOut: t('flight', 'Vietnam Airlines', '1h 20m', 64),
      },
      {
        name: 'Hoi An',
        country: 'Vietnam',
        nights: 3,
        hotel: { name: 'Little Riverside Hoi An', rating: 9.4, pricePerNight: 88, area: 'Riverside' },
        activities: [
          'Lantern-lit Ancient Town at night',
          'An Bang beach afternoon',
          'Tailor-made clothing fitting',
          'Basket boat ride in the coconut forest',
        ],
        restaurants: [
          { name: 'Bánh Mì Phượng', cuisine: 'Bánh mì', priceRange: '$' },
          { name: 'Morning Glory Original', cuisine: 'Vietnamese', priceRange: '$$' },
        ],
        vibes: ['beach', 'romance'],
      },
    ],
  },
  {
    slug: 'south-america-grand-tour',
    title: 'South America Grand Tour',
    tagline: 'Copacabana to Machu Picchu — one continent, four icons.',
    description:
      'A continent-scale sweep: Rio\'s beaches and samba, Buenos Aires\'s steakhouses and tango halls, then up into the Andes for Cusco and the lost city of Machu Picchu, landing in Lima — the food capital of the Americas.',
    coverGradient: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
    flags: '🇧🇷 🇦🇷 🇵🇪',
    scope: 'Continent',
    travelers: 2,
    cities: [
      {
        name: 'Rio de Janeiro',
        country: 'Brazil',
        nights: 3,
        hotel: { name: 'Arena Copacabana Hotel', rating: 8.4, pricePerNight: 97, area: 'Copacabana' },
        activities: [
          'Christ the Redeemer by cog train',
          'Sugarloaf cable car at sunset',
          'Ipanema beach morning + beach volleyball',
          'Selarón Steps and Santa Teresa',
        ],
        restaurants: [
          { name: 'Confeitaria Colombo', cuisine: 'Café', priceRange: '$$' },
          { name: 'Aprazível', cuisine: 'Brazilian', priceRange: '$$$' },
        ],
        vibes: ['beach', 'nightlife'],
        transportOut: t('flight', 'Aerolíneas Argentinas', '3h 25m', 189),
      },
      {
        name: 'Buenos Aires',
        country: 'Argentina',
        nights: 3,
        hotel: { name: 'Hotel Clásico', rating: 8.8, pricePerNight: 89, area: 'Palermo Hollywood' },
        activities: [
          'La Boca and Caminito color walk',
          'Recoleta Cemetery — Evita\'s grave',
          'Milonga night — live tango in San Telmo',
          'San Telmo Sunday market',
        ],
        restaurants: [
          { name: 'Don Julio', cuisine: 'Parrilla', priceRange: '$$$' },
          { name: 'Pizzería Güerrín', cuisine: 'Pizza', priceRange: '$' },
        ],
        vibes: ['nightlife', 'food'],
        transportOut: t('flight', 'LATAM', '4h 35m', 212),
      },
      {
        name: 'Cusco',
        country: 'Peru',
        nights: 3,
        hotel: { name: 'Antigua Casona San Blas', rating: 9.1, pricePerNight: 104, area: 'San Blas' },
        activities: [
          'Machu Picchu day trip via Vistadome train',
          'Sacsayhuamán fortress overlooking the city',
          'San Pedro Market — juice ladies aisle',
          'Acclimatize with coca tea in the Plaza de Armas',
        ],
        restaurants: [
          { name: 'Chicha por Gastón Acurio', cuisine: 'Andean', priceRange: '$$' },
          { name: 'Jack\'s Café', cuisine: 'Brunch', priceRange: '$' },
        ],
        vibes: ['history', 'nature'],
        transportOut: t('flight', 'LATAM', '1h 25m', 78),
      },
      {
        name: 'Lima',
        country: 'Peru',
        nights: 2,
        hotel: { name: 'Casa Andina Select Miraflores', rating: 8.6, pricePerNight: 92, area: 'Miraflores' },
        activities: [
          'Miraflores clifftop malecón walk',
          'Barranco street art and Bridge of Sighs',
          'Larco Museum and its lit-up gardens',
        ],
        restaurants: [
          { name: 'La Mar Cebichería', cuisine: 'Ceviche', priceRange: '$$' },
          { name: 'El Pan de la Chola', cuisine: 'Bakery', priceRange: '$' },
        ],
        vibes: ['food', 'city'],
      },
    ],
  },
  {
    slug: 'italian-renaissance-trail',
    title: 'Italian Renaissance Trail',
    tagline: "Colosseum to canals — Italy's greatest architecture in one sweep.",
    description:
      "A pilgrimage through Italy's architectural canon: ancient Rome's Colosseum and Pantheon, Florence's Duomo and Renaissance palaces, and Venice's Gothic basilicas floating on the lagoon. Cathedrals, cupolas, and piazzas the whole way — connected by fast trains.",
    coverGradient: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
    flags: '🇮🇹',
    scope: 'One country',
    travelers: 2,
    cities: [
      {
        name: 'Rome',
        country: 'Italy',
        nights: 3,
        hotel: { name: 'Hotel Artemide', rating: 9.0, pricePerNight: 214, area: 'Via Nazionale' },
        activities: [
          'Colosseum and Roman Forum at opening time',
          'Pantheon — the 2,000-year-old dome',
          "Vatican Museums and St. Peter's Basilica",
          'Trevi Fountain and Spanish Steps night walk',
        ],
        restaurants: [
          { name: 'Roscioli', cuisine: 'Roman', priceRange: '$$' },
          { name: 'Pizzarium Bonci', cuisine: 'Pizza al taglio', priceRange: '$' },
        ],
        vibes: ['history', 'art'],
        transportOut: t('train', 'Frecciarossa', '1h 32m', 45),
      },
      {
        name: 'Florence',
        country: 'Italy',
        nights: 3,
        hotel: { name: 'Hotel Davanzati', rating: 9.3, pricePerNight: 187, area: 'Centro Storico' },
        activities: [
          "Brunelleschi's Duomo dome climb",
          'Uffizi Gallery — Botticelli to Michelangelo',
          'Ponte Vecchio and Palazzo Vecchio',
          'Sunset from Piazzale Michelangelo',
        ],
        restaurants: [
          { name: 'Trattoria Mario', cuisine: 'Tuscan', priceRange: '$' },
          { name: "All'Antico Vinaio", cuisine: 'Panini', priceRange: '$' },
        ],
        vibes: ['art', 'history'],
        transportOut: t('train', 'Frecciarossa', '2h 5m', 39),
      },
      {
        name: 'Venice',
        country: 'Italy',
        nights: 2,
        hotel: { name: 'Hotel Antiche Figure', rating: 9.0, pricePerNight: 196, area: 'Santa Croce' },
        activities: [
          "St. Mark's Basilica and the Doge's Palace",
          'Grand Canal vaporetto at golden hour',
          "Getting lost in Dorsoduro's back alleys",
        ],
        restaurants: [
          { name: 'Osteria alle Testiere', cuisine: 'Seafood', priceRange: '$$$' },
          { name: "Dal Moro's", cuisine: 'Fresh pasta', priceRange: '$' },
        ],
        vibes: ['romance', 'art'],
      },
    ],
  },
  {
    slug: 'greek-island-escape',
    title: 'Greek Island Escape',
    tagline: 'Ancient Athens, then whitewashed villages and Aegean sunsets.',
    description:
      "Two days among the ruins of ancient Athens — the Acropolis, the Agora — then out to the islands: Santorini's caldera-edge villages and volcanic beaches, and Naxos's Venetian old town and long sandy coast. Sunsets, seafood, and slow island time.",
    coverGradient: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
    flags: '🇬🇷',
    scope: 'One country',
    travelers: 2,
    cities: [
      {
        name: 'Athens',
        country: 'Greece',
        nights: 2,
        hotel: { name: 'Athens Was Hotel', rating: 9.1, pricePerNight: 178, area: 'Plaka' },
        activities: [
          'Acropolis and Parthenon at opening time',
          'Ancient Agora and Temple of Hephaestus',
          'Plaka and Anafiotika village stroll',
        ],
        restaurants: [
          { name: 'O Thanasis', cuisine: 'Souvlaki', priceRange: '$' },
          { name: 'Ta Karamanlidika', cuisine: 'Greek deli', priceRange: '$$' },
        ],
        vibes: ['history', 'food'],
        transportOut: t('flight', 'Aegean Airlines', '0h 45m', 78),
      },
      {
        name: 'Santorini',
        country: 'Greece',
        nights: 3,
        hotel: { name: 'Caldera Villas Oia', rating: 9.2, pricePerNight: 265, area: 'Oia' },
        activities: [
          'Oia sunset from the castle ruins',
          'Caldera-edge hike from Fira to Oia',
          'Red Beach and the Akrotiri ruins',
          'Catamaran cruise with hot-springs swim',
        ],
        restaurants: [
          { name: 'Metaxi Mas', cuisine: 'Greek', priceRange: '$$' },
          { name: "Lucky's Souvlakis", cuisine: 'Souvlaki', priceRange: '$' },
        ],
        vibes: ['romance', 'beach'],
        transportOut: t('flight', 'Sky Express', '0h 35m', 62),
      },
      {
        name: 'Naxos',
        country: 'Greece',
        nights: 3,
        hotel: { name: 'Naxos Island Hotel', rating: 9.0, pricePerNight: 96, area: 'Agios Prokopios' },
        activities: [
          'Portara — the marble temple gate at sunset',
          'Agios Prokopios beach day',
          'Old Town Kastro and its Venetian alleys',
        ],
        restaurants: [
          { name: 'Axiotissa Taverna', cuisine: 'Farm-to-table', priceRange: '$$' },
          { name: 'To Elliniko', cuisine: 'Greek', priceRange: '$' },
        ],
        vibes: ['beach', 'nature'],
      },
    ],
  },
];

const EMPTY_TRANSPORT: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Total nights across a preset. */
export function presetNights(preset: PresetItinerary): number {
  return preset.cities.reduce((s, c) => s + c.nights, 0);
}

/** Rough all-in cost: hotels + inter-city transport for the whole party. */
export function presetCost(preset: PresetItinerary): number {
  const hotels = preset.cities.reduce((s, c) => s + c.hotel.pricePerNight * c.nights, 0);
  const transport = preset.cities.reduce(
    (s, c) => s + (c.transportOut?.price ?? 0) * preset.travelers,
    0,
  );
  return Math.round(hotels + transport);
}

/**
 * Materialize a preset into a full Trip payload ready for saveTrip().
 * Stamps a rolling start date (~30 days out) and chains city dates by
 * nights, wires transportIn/transportOut between neighbors, and assigns
 * stable colorIndex slots — so the canvas treats it exactly like a trip
 * the user planned themselves.
 */
export function buildPresetTrip(preset: PresetItinerary): Trip {
  const start = new Date();
  start.setDate(start.getDate() + 30);

  let cursor = new Date(start);
  const cities: City[] = preset.cities.map((pc, i) => {
    const arrival = toIso(cursor);
    const dep = new Date(cursor);
    dep.setDate(dep.getDate() + pc.nights);
    const departure = toIso(dep);
    cursor = dep;

    const transportOut = pc.transportOut
      ? { ...pc.transportOut, from: pc.name, to: preset.cities[i + 1]?.name ?? '' }
      : { ...EMPTY_TRANSPORT };
    const prev = preset.cities[i - 1];
    const transportIn = prev?.transportOut
      ? { ...prev.transportOut, from: prev.name, to: pc.name }
      : { ...EMPTY_TRANSPORT };

    return {
      name: pc.name,
      country: pc.country,
      dates: { arrival, departure },
      transportIn,
      transportOut,
      hotel: pc.hotel,
      hotels: [pc.hotel],
      selectedHotelIndex: 0,
      activities: pc.activities,
      restaurants: pc.restaurants,
      vibes: pc.vibes,
      colorIndex: i,
    };
  });

  return {
    title: preset.title,
    status: 'planning',
    totalCost: presetCost(preset),
    savings: 0,
    travelers: preset.travelers,
    cities,
    savingsTips: [],
    // Default home anchor — every preset starts from New York (JFK).
    // Users change it on their saved copy via the canvas home card.
    origin: { city: 'New York', airports: ['JFK'] },
    returnToHome: true,
  };
}
