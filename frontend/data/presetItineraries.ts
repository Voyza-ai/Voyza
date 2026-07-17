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
  /** Invisible search keywords — traits of the trip that users search for
   *  but that don't necessarily appear in the visible text ("tropical",
   *  "northern lights", "backpacking"). Indexed at high weight. */
  searchTags?: string[];
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
    searchTags: ['temples', 'zen', 'neon', 'cherry blossom', 'onsen', 'hot springs', 'bullet train', 'sushi'],
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
    searchTags: ['palaces', 'museums', 'canals', 'cathedrals', 'old town', 'castles', 'cafes'],
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
    searchTags: ['tropical', 'jungle', 'humid', 'street food', 'temples', 'backpacking', 'lanterns', 'warm'],
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
    searchTags: ['andes', 'mountains', 'tango', 'carnival', 'inca', 'ruins', 'salsa'],
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
    searchTags: ['architecture', 'renaissance', 'cathedrals', 'domes', 'pasta', 'romantic', 'piazzas'],
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
    searchTags: ['islands', 'mediterranean', 'sunsets', 'whitewashed', 'aegean', 'summer', 'warm', 'ferries'],
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
  {
    slug: 'paris-long-weekend',
    searchTags: ['romantic', 'cafes', 'museums', 'weekend', 'city break', 'pastries'],
    title: 'Paris Long Weekend',
    tagline: 'Three nights of museums, cafés, and golden-hour Seine walks.',
    description:
      'The perfect quick escape: the Louvre and Musée d\'Orsay, croissants in Le Marais, a sunset climb to Sacré-Cœur, and an evening under the Eiffel Tower sparkle. Short enough for a work week, rich enough to feel like a real trip.',
    coverGradient: 'linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)',
    flags: '🇫🇷',
    scope: 'City break',
    travelers: 2,
    cities: [
      {
        name: 'Paris',
        country: 'France',
        nights: 3,
        hotel: { name: 'Hôtel des Grands Boulevards', rating: 8.9, pricePerNight: 224, area: '2nd Arrondissement' },
        activities: [
          'Louvre highlights + Musée d\'Orsay afternoon',
          'Le Marais café and pastry crawl',
          'Sunset from Sacré-Cœur in Montmartre',
          'Seine walk and the Eiffel Tower sparkle at dusk',
        ],
        restaurants: [
          { name: 'Breizh Café', cuisine: 'Crêperie', priceRange: '$' },
          { name: 'Chez Janou', cuisine: 'Provençal', priceRange: '$$' },
        ],
        vibes: ['romance', 'art', 'food'],
      },
    ],
  },
  {
    slug: 'reykjavik-adventure-weekend',
    searchTags: ['northern lights', 'waterfalls', 'geothermal', 'glaciers', 'volcano', 'cold', 'winter', 'nordic', 'weekend'],
    title: 'Reykjavik Adventure Weekend',
    tagline: 'Waterfalls, geysers, and geothermal lagoons in four wild days.',
    description:
      'Iceland compressed into a long weekend: the Golden Circle\'s geysers and waterfalls, a soak in the Blue Lagoon\'s milky-blue water, black-sand beaches, and — in winter — a shot at the northern lights. Nature at full volume, minutes from a walkable little capital.',
    coverGradient: 'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
    flags: '🇮🇸',
    scope: 'City break',
    travelers: 2,
    cities: [
      {
        name: 'Reykjavik',
        country: 'Iceland',
        nights: 4,
        hotel: { name: 'Center Hotels Plaza', rating: 8.6, pricePerNight: 189, area: 'Old Town' },
        activities: [
          'Golden Circle day — Geysir, Gullfoss waterfall, Þingvellir rift',
          'Blue Lagoon geothermal soak',
          'South coast black-sand beach at Reynisfjara',
          'Northern lights hunt (Sep–Mar)',
        ],
        restaurants: [
          { name: 'Bæjarins Beztu Pylsur', cuisine: 'Hot dogs', priceRange: '$' },
          { name: 'Messinn', cuisine: 'Seafood', priceRange: '$$' },
        ],
        vibes: ['nature', 'city'],
      },
    ],
  },
  {
    slug: 'lisbon-sintra-escape',
    searchTags: ['coastal', 'sunny', 'tiles', 'palaces', 'pastries', 'weekend', 'city break'],
    title: 'Lisbon & Sintra Escape',
    tagline: 'Tiled hills and pastel palaces — a four-night Portuguese fix.',
    description:
      'Lisbon\'s miradouros, tram 28, and pastéis de nata straight from the oven, then a night out in fairy-tale Sintra beneath the technicolor Pena Palace. Small distances, big atmosphere — Europe\'s easiest short escape.',
    coverGradient: 'linear-gradient(135deg, #f6d365 0%, #fda085 100%)',
    flags: '🇵🇹',
    scope: 'City break',
    travelers: 2,
    cities: [
      {
        name: 'Lisbon',
        country: 'Portugal',
        nights: 3,
        hotel: { name: 'My Story Hotel Rossio', rating: 8.8, pricePerNight: 142, area: 'Rossio' },
        activities: [
          'Alfama miradouro walk and tram 28',
          'Belém Tower and pastéis de Belém',
          'LX Factory and Time Out Market grazing',
        ],
        restaurants: [
          { name: 'Time Out Market', cuisine: 'Food hall', priceRange: '$$' },
          { name: 'Cervejaria Ramiro', cuisine: 'Seafood', priceRange: '$$' },
        ],
        vibes: ['food', 'city'],
        transportOut: t('train', 'CP Urbano', '0h 40m', 3),
      },
      {
        name: 'Sintra',
        country: 'Portugal',
        nights: 1,
        hotel: { name: 'Sintra Boutique Hotel', rating: 8.7, pricePerNight: 128, area: 'Historic Centre' },
        activities: [
          'Pena Palace early entry — beat the tour buses',
          'Quinta da Regaleira\'s initiation well',
          'Moorish Castle ramparts walk',
        ],
        restaurants: [
          { name: 'Tascantiga', cuisine: 'Petiscos', priceRange: '$' },
        ],
        vibes: ['history', 'romance'],
      },
    ],
  },
  {
    slug: 'grand-asia-expedition',
    searchTags: ['tropical', 'street food', 'temples', 'markets', 'megacities', 'surf', 'rice terraces', 'warm'],
    title: 'Grand Asia Expedition',
    tagline: 'Tokyo to Bali — 18 nights across five countries.',
    description:
      'The big one: Tokyo\'s neon and izakayas, Seoul\'s markets and palace quarters, Bangkok\'s river life, Singapore\'s hawker centres, and a wind-down week-end of rice terraces and surf beaches in Bali. Five countries, one continent-sized memory.',
    coverGradient: 'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
    flags: '🇯🇵 🇰🇷 🇹🇭 🇸🇬 🇮🇩',
    scope: '5 countries',
    travelers: 2,
    cities: [
      {
        name: 'Tokyo',
        country: 'Japan',
        nights: 4,
        hotel: { name: 'Shibuya Stream Excel', rating: 8.8, pricePerNight: 176, area: 'Shibuya' },
        activities: [
          'Shibuya and Shinjuku neon crawl',
          'Tsukiji Outer Market breakfast',
          'Day trip to Kamakura\'s Great Buddha',
        ],
        restaurants: [
          { name: 'Uobei Sushi', cuisine: 'Conveyor sushi', priceRange: '$' },
          { name: 'Omoide Yokocho stalls', cuisine: 'Yakitori', priceRange: '$' },
        ],
        vibes: ['city', 'food'],
        transportOut: t('flight', 'Korean Air', '2h 20m', 142),
      },
      {
        name: 'Seoul',
        country: 'South Korea',
        nights: 3,
        hotel: { name: 'L7 Myeongdong', rating: 8.9, pricePerNight: 138, area: 'Myeongdong' },
        activities: [
          'Gyeongbokgung Palace changing of the guard',
          'Bukchon Hanok Village morning walk',
          'Gwangjang Market food alley',
        ],
        restaurants: [
          { name: 'Gwangjang bindaetteok stalls', cuisine: 'Korean', priceRange: '$' },
          { name: 'Maple Tree House', cuisine: 'Korean BBQ', priceRange: '$$' },
        ],
        vibes: ['city', 'food'],
        transportOut: t('flight', 'Thai Airways', '5h 35m', 228),
      },
      {
        name: 'Bangkok',
        country: 'Thailand',
        nights: 4,
        hotel: { name: 'Riva Surya Bangkok', rating: 8.7, pricePerNight: 92, area: 'Riverside' },
        activities: [
          'Grand Palace at opening time',
          'Chao Phraya longtail boat through the khlongs',
          'Chatuchak weekend market',
        ],
        restaurants: [
          { name: 'Raan Jay Fai', cuisine: 'Street food', priceRange: '$$' },
          { name: 'Or Tor Kor Market', cuisine: 'Thai', priceRange: '$' },
        ],
        vibes: ['food', 'city'],
        transportOut: t('flight', 'Singapore Airlines', '2h 25m', 156),
      },
      {
        name: 'Singapore',
        country: 'Singapore',
        nights: 3,
        hotel: { name: 'Hotel G Singapore', rating: 8.5, pricePerNight: 154, area: 'Bugis' },
        activities: [
          'Gardens by the Bay light show',
          'Hawker centre crawl — Maxwell to Lau Pa Sat',
          'Sentosa afternoon',
        ],
        restaurants: [
          { name: 'Maxwell Food Centre', cuisine: 'Hawker', priceRange: '$' },
          { name: 'Jumbo Seafood', cuisine: 'Chilli crab', priceRange: '$$$' },
        ],
        vibes: ['city', 'food'],
        transportOut: t('flight', 'Scoot', '2h 40m', 88),
      },
      {
        name: 'Bali',
        country: 'Indonesia',
        nights: 4,
        hotel: { name: 'Alaya Resort Ubud', rating: 9.0, pricePerNight: 118, area: 'Ubud' },
        activities: [
          'Tegallalang rice terraces at sunrise',
          'Uluwatu clifftop sunset and kecak dance',
          'Surf lesson at Canggu',
          'Tirta Empul water blessing',
        ],
        restaurants: [
          { name: 'Warung Babi Guling Ibu Oka', cuisine: 'Balinese', priceRange: '$' },
          { name: 'La Brisa Canggu', cuisine: 'Beach club', priceRange: '$$' },
        ],
        vibes: ['beach', 'nature'],
      },
    ],
  },
  {
    slug: 'mediterranean-odyssey',
    searchTags: ['mediterranean', 'coastal', 'ancient', 'summer', 'seaside', 'bazaars', 'ruins', 'warm'],
    title: 'Mediterranean Odyssey',
    tagline: 'Barcelona to Istanbul — two weeks around the ancient sea.',
    description:
      'A 14-night sweep along the Mediterranean\'s greatest hits: Gaudí\'s Barcelona, the Riviera glamour of Nice, Rome\'s ruins and trattorias, Athens beneath the Acropolis, and the bazaars and bosphorus ferries of Istanbul — where Europe runs out and Asia begins.',
    coverGradient: 'linear-gradient(135deg, #2193b0 0%, #6dd5ed 100%)',
    flags: '🇪🇸 🇫🇷 🇮🇹 🇬🇷 🇹🇷',
    scope: '5 countries',
    travelers: 2,
    cities: [
      {
        name: 'Barcelona',
        country: 'Spain',
        nights: 3,
        hotel: { name: 'Hotel Jazz', rating: 8.7, pricePerNight: 168, area: 'Eixample' },
        activities: [
          'Sagrada Família and Park Güell — Gaudí day',
          'Gothic Quarter wander',
          'Barceloneta beach evening',
        ],
        restaurants: [
          { name: 'El Xampanyet', cuisine: 'Tapas', priceRange: '$$' },
          { name: 'La Boqueria stalls', cuisine: 'Market', priceRange: '$' },
        ],
        vibes: ['art', 'beach'],
        transportOut: t('flight', 'Vueling', '1h 5m', 64),
      },
      {
        name: 'Nice',
        country: 'France',
        nights: 2,
        hotel: { name: 'Hôtel Rossetti', rating: 8.8, pricePerNight: 146, area: 'Vieux Nice' },
        activities: [
          'Promenade des Anglais sunrise ride',
          'Castle Hill viewpoint',
          'Day dip to Villefranche-sur-Mer',
        ],
        restaurants: [
          { name: 'Chez Pipo', cuisine: 'Socca', priceRange: '$' },
          { name: 'La Rossettisserie', cuisine: 'French', priceRange: '$$' },
        ],
        vibes: ['beach', 'romance'],
        transportOut: t('flight', 'ITA Airways', '1h 10m', 78),
      },
      {
        name: 'Rome',
        country: 'Italy',
        nights: 3,
        hotel: { name: 'Hotel Smeraldo', rating: 8.5, pricePerNight: 158, area: 'Campo de\' Fiori' },
        activities: [
          'Colosseum and Forum morning',
          'Trastevere evening wander',
          'Vatican at first entry',
        ],
        restaurants: [
          { name: 'Da Enzo al 29', cuisine: 'Roman', priceRange: '$$' },
          { name: 'Supplizio', cuisine: 'Street food', priceRange: '$' },
        ],
        vibes: ['history', 'food'],
        transportOut: t('flight', 'Aegean Airlines', '1h 55m', 96),
      },
      {
        name: 'Athens',
        country: 'Greece',
        nights: 3,
        hotel: { name: 'Ergon House', rating: 9.0, pricePerNight: 172, area: 'Monastiraki' },
        activities: [
          'Acropolis at opening bell',
          'Central Market and Psyrri streets',
          'Cape Sounion sunset — Temple of Poseidon',
        ],
        restaurants: [
          { name: 'Karamanlidika', cuisine: 'Greek deli', priceRange: '$$' },
          { name: 'Lukumades', cuisine: 'Dessert', priceRange: '$' },
        ],
        vibes: ['history', 'food'],
        transportOut: t('flight', 'Turkish Airlines', '1h 25m', 102),
      },
      {
        name: 'Istanbul',
        country: 'Turkey',
        nights: 3,
        hotel: { name: 'Hotel Amira Istanbul', rating: 9.2, pricePerNight: 134, area: 'Sultanahmet' },
        activities: [
          'Hagia Sophia and the Blue Mosque',
          'Grand Bazaar and spice market haggling',
          'Bosphorus ferry to the Asian side',
        ],
        restaurants: [
          { name: 'Çiya Sofrası', cuisine: 'Anatolian', priceRange: '$$' },
          { name: 'Karaköy Güllüoğlu', cuisine: 'Baklava', priceRange: '$' },
        ],
        vibes: ['history', 'food'],
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

/** Duration buckets that drive the Browse filter chips. */
export type DurationBucket = 'short' | 'medium' | 'long';

export const DURATION_BUCKETS: Array<{
  key: DurationBucket;
  label: string;
  hint: string;
}> = [
  { key: 'short', label: 'Quick getaway', hint: '≤ 5 nights' },
  { key: 'medium', label: 'Classic trip', hint: '6–12 nights' },
  { key: 'long', label: 'Extended', hint: '13+ nights' },
];

export function presetDurationBucket(preset: PresetItinerary): DurationBucket {
  const nights = presetNights(preset);
  if (nights <= 5) return 'short';
  if (nights <= 12) return 'medium';
  return 'long';
}

/** Unique vibes across a preset's cities — drives the vibe filter chips. */
export function presetVibes(preset: PresetItinerary): Vibe[] {
  const set = new Set<Vibe>();
  for (const c of preset.cities) for (const v of c.vibes) set.add(v);
  return Array.from(set);
}

/** Budget buckets (whole-party estimated cost) for the Browse filter. */
export type BudgetBucket = 'budget' | 'mid' | 'premium';

export const BUDGET_BUCKETS: Array<{
  key: BudgetBucket;
  label: string;
  hint: string;
}> = [
  { key: 'budget', label: 'Budget', hint: 'under $1k' },
  { key: 'mid', label: 'Mid-range', hint: '$1k–2.5k' },
  { key: 'premium', label: 'Premium', hint: '$2.5k+' },
];

export function presetBudgetBucket(preset: PresetItinerary): BudgetBucket {
  const cost = presetCost(preset);
  if (cost < 1000) return 'budget';
  if (cost <= 2500) return 'mid';
  return 'premium';
}

/** Rough all-in cost for a given party size: hotel rooms sleep 2, so rooms
 *  scale at ceil(travelers/2); inter-city transport is per person. */
export function presetCostFor(preset: PresetItinerary, travelers: number): number {
  const rooms = Math.max(1, Math.ceil(travelers / 2));
  const hotels =
    preset.cities.reduce((s, c) => s + c.hotel.pricePerNight * c.nights, 0) * rooms;
  const transport = preset.cities.reduce(
    (s, c) => s + (c.transportOut?.price ?? 0) * travelers,
    0,
  );
  return Math.round(hotels + transport);
}

/** Cost at the preset's default party size — used on the browse cards. */
export function presetCost(preset: PresetItinerary): number {
  return presetCostFor(preset, preset.travelers);
}

/**
 * Materialize a preset into a full Trip payload ready for saveTrip().
 * Stamps a rolling start date (~30 days out) and chains city dates by
 * nights, wires transportIn/transportOut between neighbors, and assigns
 * stable colorIndex slots — so the canvas treats it exactly like a trip
 * the user planned themselves.
 */
export function buildPresetTrip(
  preset: PresetItinerary,
  travelers: number = preset.travelers,
): Trip {
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
    totalCost: presetCostFor(preset, travelers),
    savings: 0,
    travelers,
    cities,
    savingsTips: [],
    // Default home anchor — every preset starts from New York (JFK).
    // Users change it on their saved copy via the canvas home card.
    origin: { city: 'New York', airports: ['JFK'] },
    returnToHome: true,
  };
}
