/**
 * Playground object catalog and country reference data.
 * Plain data (no runtime dependencies) — used by the JARVIS intent parser on the
 * server and by the 3D engine / info panels on the client.
 */

export interface CatalogEntry {
  id: string;
  name: string;
  aliases: string[];
  category: "Planet" | "Star" | "System" | "Science" | "Anatomy" | "Machine" | "Primitive" | "Iron Man" | "Spider-Man" | "Physics" | "Futuristic" | "Radiation";
  /** Real reference facts shown in the object panel. */
  facts: { label: string; value: string }[];
  /** Capabilities the object supports (drives which properties JARVIS may toggle). */
  features?: ("atmosphere" | "clouds" | "rings" | "orbits" | "explode" | "locations")[];
}

export const OBJECT_CATALOG: CatalogEntry[] = [
  {
    id: "earth",
    name: "Earth",
    aliases: ["earth", "globe", "world", "planet earth", "3d earth"],
    category: "Planet",
    facts: [
      { label: "Radius", value: "6,371 km" },
      { label: "Population", value: "8.1 billion" },
      { label: "Continents", value: "7" },
      { label: "Axial tilt", value: "23.4°" },
    ],
    features: ["atmosphere", "clouds", "locations"],
  },
  {
    id: "moon",
    name: "Moon",
    aliases: ["moon", "the moon", "luna"],
    category: "Planet",
    facts: [
      { label: "Radius", value: "1,737 km" },
      { label: "Distance", value: "384,400 km" },
      { label: "Orbit", value: "27.3 days" },
    ],
  },
  {
    id: "mars",
    name: "Mars",
    aliases: ["mars", "red planet"],
    category: "Planet",
    facts: [
      { label: "Radius", value: "3,390 km" },
      { label: "Day length", value: "24h 37m" },
      { label: "Moons", value: "2" },
    ],
    features: ["atmosphere"],
  },
  {
    id: "saturn",
    name: "Saturn",
    aliases: ["saturn", "ringed planet"],
    category: "Planet",
    facts: [
      { label: "Radius", value: "58,232 km" },
      { label: "Day length", value: "10h 33m" },
      { label: "Distance from Sun", value: "1.43 billion km" },
    ],
    features: ["rings"],
  },
  {
    id: "sun",
    name: "Sun",
    aliases: ["sun", "the sun", "star"],
    category: "Star",
    facts: [
      { label: "Radius", value: "696,340 km" },
      { label: "Surface temp", value: "5,772 K" },
      { label: "Age", value: "4.6 billion years" },
    ],
  },
  {
    id: "solar_system",
    name: "Solar System",
    aliases: ["solar system", "planets", "the solar system"],
    category: "System",
    facts: [
      { label: "Planets", value: "8" },
      { label: "Star", value: "Sun (G2V)" },
      { label: "Age", value: "4.6 billion years" },
    ],
    features: ["orbits", "explode"],
  },
  {
    id: "atom",
    name: "Carbon Atom",
    aliases: ["atom", "carbon atom", "carbon"],
    category: "Science",
    facts: [
      { label: "Protons", value: "6" },
      { label: "Neutrons", value: "6" },
      { label: "Electrons", value: "6" },
    ],
    features: ["orbits", "explode"],
  },
  {
    id: "dna",
    name: "DNA Helix",
    aliases: ["dna", "double helix", "helix", "dna helix"],
    category: "Science",
    facts: [
      { label: "Structure", value: "Double helix" },
      { label: "Base pairs / turn", value: "~10.5" },
      { label: "Helix width", value: "~2 nm" },
    ],
  },
  {
    id: "car",
    name: "Sports Car",
    aliases: ["car", "sports car", "vehicle", "supercar"],
    category: "Machine",
    facts: [
      { label: "Type", value: "Concept coupe" },
      { label: "Parts", value: "Body, cabin, 4 wheels" },
    ],
    features: ["explode"],
  },
  {
    id: "engine",
    name: "V8 Engine",
    aliases: ["engine", "v8", "v8 engine", "motor"],
    category: "Machine",
    facts: [
      { label: "Layout", value: "V8, 90°" },
      { label: "Cylinders", value: "8" },
    ],
    features: ["explode"],
  },
  {
    id: "heart",
    name: "Human Heart",
    aliases: ["heart", "human heart"],
    category: "Anatomy",
    facts: [
      { label: "Chambers", value: "4" },
      { label: "Resting rate", value: "60–100 bpm" },
      { label: "Mass", value: "~300 g" },
    ],
  },
  {
    id: "brain",
    name: "Human Brain",
    aliases: ["brain", "human brain"],
    category: "Anatomy",
    facts: [
      { label: "Neurons", value: "~86 billion" },
      { label: "Mass", value: "~1.4 kg" },
      { label: "Hemispheres", value: "2" },
    ],
  },
  // ── Iron Man ──
  {
    id: "mark3",
    name: "Mark III Armor",
    aliases: ["mark 3", "mark three", "mark iii", "mark 3 suit", "mark three suit", "iron man suit", "iron man armor", "iron man", "classic iron man"],
    category: "Iron Man",
    facts: [
      { label: "Debut", value: "Iron Man (2008)" },
      { label: "Finish", value: "Hot-rod red + gold-titanium" },
      { label: "Power", value: "Arc reactor (palladium)" },
    ],
  },
  {
    id: "mark42",
    name: "Mark 42 Armor",
    aliases: ["mark 42", "mark forty two", "mark xlii", "prodigal son", "gold iron man"],
    category: "Iron Man",
    facts: [
      { label: "Debut", value: "Iron Man 3 (2013)" },
      { label: "Feature", value: "Self-assembling modules" },
      { label: "Finish", value: "Gold-dominant" },
    ],
  },
  {
    id: "mark50",
    name: "Mark 50 Nanotech",
    aliases: ["mark 50", "mark fifty", "mark l", "nanotech suit", "bleeding edge", "infinity war suit"],
    category: "Iron Man",
    facts: [
      { label: "Debut", value: "Infinity War (2018)" },
      { label: "Tech", value: "Nanoparticle armor" },
      { label: "Housing", value: "Chest reactor unit" },
    ],
  },
  {
    id: "mark85",
    name: "Mark 85 Armor",
    aliases: ["mark 85", "mark eighty five", "mark lxxxv", "endgame suit", "final suit"],
    category: "Iron Man",
    facts: [
      { label: "Debut", value: "Endgame (2019)" },
      { label: "Tech", value: "Nanotech, reinforced" },
      { label: "Finish", value: "Red with heavy gold" },
    ],
  },
  {
    id: "hulkbuster",
    name: "Hulkbuster",
    aliases: ["hulkbuster", "hulk buster", "mark 44", "mark xliv", "veronica"],
    category: "Iron Man",
    facts: [
      { label: "Debut", value: "Age of Ultron (2015)" },
      { label: "Role", value: "Heavy containment armor" },
      { label: "Height", value: "~3 m" },
    ],
  },
  {
    id: "arc_reactor",
    name: "Arc Reactor Mk I",
    aliases: ["arc reactor", "reactor", "mark 1 reactor", "mark one reactor", "palladium reactor", "miniature arc reactor"],
    category: "Iron Man",
    facts: [
      { label: "Core", value: "Palladium" },
      { label: "Output", value: "~3 GJ/s (fictional)" },
      { label: "Coils", value: "10 copper windings" },
    ],
  },
  {
    id: "arc_reactor2",
    name: "Arc Reactor Mk II",
    aliases: ["new element reactor", "triangle reactor", "triangular reactor", "mark 2 reactor", "mark two reactor", "vibranium reactor", "new arc reactor"],
    category: "Iron Man",
    facts: [
      { label: "Core", value: "New element (triangular)" },
      { label: "Debut", value: "Iron Man 2 (2010)" },
    ],
  },
  // ── Spider-Man ──
  {
    id: "spider_classic",
    name: "Spider-Man Suit",
    aliases: ["spider man", "spiderman", "spider-man", "spider man suit", "spiderman suit", "classic spider man", "spidey"],
    category: "Spider-Man",
    facts: [
      { label: "Style", value: "Classic red & blue" },
      { label: "Web pattern", value: "Raised silver lines" },
    ],
  },
  {
    id: "iron_spider",
    name: "Iron Spider",
    aliases: ["iron spider", "iron spider suit", "iron-spider"],
    category: "Spider-Man",
    facts: [
      { label: "Debut", value: "Infinity War (2018)" },
      { label: "Feature", value: "4 mechanical legs" },
      { label: "Tech", value: "Stark nanotech" },
    ],
  },
  // ── Space ──
  {
    id: "black_hole",
    name: "Gargantua",
    aliases: ["black hole", "blackhole", "gargantua", "interstellar black hole", "interstellar"],
    category: "Star",
    facts: [
      { label: "Type", value: "Spinning supermassive" },
      { label: "Mass", value: "~100 million suns" },
      { label: "Shown", value: "Accretion disk + lensing" },
    ],
  },
  // ── Physics & quantum ──
  {
    id: "double_slit",
    name: "Double-Slit Experiment",
    aliases: ["double slit", "double slit experiment", "young's double slit", "youngs double slit", "young double slit", "wave particle duality", "interference experiment"],
    category: "Physics",
    facts: [
      { label: "First done", value: "Thomas Young, 1801" },
      { label: "Shows", value: "Wave–particle duality" },
      { label: "Fringe spacing", value: "λL / d" },
    ],
  },
  {
    id: "newton_cradle",
    name: "Newton's Cradle",
    aliases: ["newton's cradle", "newtons cradle", "newton cradle", "cradle"],
    category: "Physics",
    facts: [
      { label: "Shows", value: "Momentum + energy conservation" },
      { label: "Balls", value: "5" },
    ],
  },
  {
    id: "prism",
    name: "Newton's Prism",
    aliases: ["prism", "light prism", "newton's prism", "dispersion", "rainbow prism"],
    category: "Physics",
    facts: [
      { label: "First done", value: "Isaac Newton, 1666" },
      { label: "Shows", value: "White light is a spectrum" },
    ],
  },
  {
    id: "tesseract",
    name: "Tesseract (4D)",
    aliases: ["tesseract", "hypercube", "4d cube", "four dimensional cube", "4d"],
    category: "Futuristic",
    facts: [
      { label: "Dimensions", value: "4" },
      { label: "Vertices", value: "16" },
      { label: "Edges", value: "32" },
    ],
  },
  {
    id: "quantum_computer",
    name: "Quantum Computer",
    aliases: ["quantum computer", "quantum chandelier", "dilution refrigerator", "qubit computer", "quantum"],
    category: "Futuristic",
    facts: [
      { label: "Qubits", value: "Superconducting" },
      { label: "Coldest stage", value: "~15 millikelvin" },
      { label: "Stages", value: "5 temperature plates" },
    ],
  },
  // ── Radiation & light ──
  {
    id: "xray_machine",
    name: "X-Ray Machine",
    aliases: ["x ray machine", "x-ray machine", "xray machine", "x ray", "x-ray", "xray", "x rays", "x-rays", "x ray tube", "x-ray tube", "radiography", "x ray animation", "xray animation", "x-ray animation"],
    category: "Radiation",
    facts: [
      { label: "Discovered", value: "Wilhelm Röntgen, 1895" },
      { label: "Tube voltage", value: "60–150 kV" },
      { label: "Wavelength", value: "0.01–10 nm" },
    ],
  },
  {
    id: "gamma_rays",
    name: "Gamma Radiation",
    aliases: ["gamma radiation", "gamma rays", "gamma ray", "gamma", "radioactive decay", "radioactivity", "nuclear decay", "nuclear radiation", "alpha beta gamma", "radiation shielding"],
    category: "Radiation",
    facts: [
      { label: "Wavelength", value: "< 0.01 nm" },
      { label: "Stopped by", value: "Thick lead or concrete" },
      { label: "Discovered", value: "Paul Villard, 1900" },
    ],
  },
  {
    id: "photon",
    name: "Photon & EM Wave",
    aliases: ["photon", "photons", "em wave", "electromagnetic wave", "electromagnetic waves", "electromagnetic spectrum", "electromagnetic radiation", "light wave", "light waves", "spectrum"],
    category: "Radiation",
    facts: [
      { label: "Speed", value: "299,792 km/s" },
      { label: "Rest mass", value: "0" },
      { label: "Energy", value: "E = h·f" },
    ],
  },
  {
    id: "laser",
    name: "Laser",
    aliases: ["laser", "lasers", "ruby laser", "laser beam", "stimulated emission"],
    category: "Radiation",
    facts: [
      { label: "First built", value: "Theodore Maiman, 1960" },
      { label: "Stands for", value: "Light Amplification by Stimulated Emission of Radiation" },
      { label: "Ruby laser", value: "694 nm, deep red" },
    ],
  },
  {
    id: "pulsar",
    name: "Pulsar",
    aliases: ["pulsar", "pulsars", "neutron star", "spinning neutron star", "magnetar", "pulsating star"],
    category: "Star",
    facts: [
      { label: "Diameter", value: "~20 km" },
      { label: "Spin", value: "Up to 716 times a second" },
      { label: "Density", value: "~1 billion tonnes per teaspoon" },
    ],
  },
  {
    id: "collider",
    name: "Particle Collider",
    aliases: ["particle collider", "collider", "large hadron collider", "hadron collider", "lhc", "particle accelerator", "atlas detector", "cern", "higgs boson", "particle collision", "particle physics"],
    category: "Physics",
    facts: [
      { label: "Collision energy", value: "13.6 TeV (LHC)" },
      { label: "Ring", value: "27 km" },
      { label: "Collisions", value: "Up to a billion a second" },
    ],
  },
  {
    id: "tokamak",
    name: "Fusion Reactor",
    aliases: ["fusion reactor", "tokamak", "nuclear fusion", "fusion", "iter", "fusion power", "plasma reactor", "star in a jar"],
    category: "Futuristic",
    facts: [
      { label: "Plasma", value: "~150 million °C" },
      { label: "Fuel", value: "Deuterium + tritium" },
      { label: "Example", value: "ITER, France" },
    ],
  },
  { id: "cube", name: "Cube", aliases: ["cube", "box"], category: "Primitive", facts: [{ label: "Faces", value: "6" }] },
  { id: "sphere", name: "Sphere", aliases: ["sphere", "ball", "orb"], category: "Primitive", facts: [] },
  {
    id: "torus",
    name: "Torus Knot",
    aliases: ["torus", "torus knot", "knot", "donut", "ring"],
    category: "Primitive",
    facts: [],
  },
  {
    id: "pyramid",
    name: "Pyramid",
    aliases: ["pyramid", "tetrahedron"],
    category: "Primitive",
    facts: [{ label: "Faces", value: "5" }],
  },
];

const byId = new Map(OBJECT_CATALOG.map((e) => [e.id, e]));

/** Carousel / voice collections ("pull up everything we have on Iron Man"). */
export interface Collection {
  id: string;
  name: string;
  aliases: string[];
  categories: CatalogEntry["category"][];
}

export const COLLECTIONS: Collection[] = [
  { id: "ironman", name: "Iron Man", aliases: ["iron man", "ironman", "tony stark", "stark", "stark industries", "the avengers", "avengers", "marvel"], categories: ["Iron Man"] },
  { id: "spiderman", name: "Spider-Man", aliases: ["spider man", "spiderman", "spider-man", "peter parker", "spidey"], categories: ["Spider-Man"] },
  { id: "space", name: "Space", aliases: ["space", "planets", "astronomy", "the universe", "universe", "cosmos", "stars"], categories: ["Planet", "Star", "System"] },
  { id: "physics", name: "Physics & Quantum", aliases: ["physics", "quantum", "quantum physics", "science", "experiments", "science experiments", "quantum experiments", "futuristic", "futuristic stuff"], categories: ["Physics", "Futuristic", "Science", "Radiation"] },
  { id: "radiation", name: "Radiation & Light", aliases: ["radiation", "light", "x rays", "x-rays", "gamma rays", "photons", "nuclear", "radioactivity", "rays", "radiation and light"], categories: ["Radiation"] },
  { id: "anatomy", name: "Anatomy", aliases: ["anatomy", "human body", "biology", "medical", "organs"], categories: ["Anatomy"] },
  { id: "machines", name: "Machines", aliases: ["machines", "cars", "engineering", "vehicles", "engines"], categories: ["Machine"] },
  { id: "shapes", name: "Shapes", aliases: ["shapes", "primitives", "geometry"], categories: ["Primitive"] },
  { id: "yours", name: "Your models", aliases: ["my models", "my stuff", "imported models", "my files", "your models", "my uploads"], categories: [] },
];

export function collectionOf(id: string): Collection | undefined {
  return COLLECTIONS.find((c) => c.id === id);
}

/** "everything on iron man" → "ironman". Longest alias wins. */
export function resolveCollection(input: string): string | null {
  const exact = input.trim().toLowerCase();
  if (COLLECTIONS.some((c) => c.id === exact)) return exact; // tab ids ("yours", "ironman"…)
  const text = ` ${input.toLowerCase().replace(/[^a-z0-9 -]+/g, " ").replace(/\s+/g, " ").trim()} `;
  let best: { id: string; len: number } | null = null;
  for (const c of COLLECTIONS) {
    for (const alias of [c.name.toLowerCase(), ...c.aliases]) {
      if (text.includes(` ${alias} `) && (!best || alias.length > best.len)) best = { id: c.id, len: alias.length };
    }
  }
  return best?.id ?? null;
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return byId.get(id);
}

/** Resolve free text ("a 3d earth", "the sun") to a catalog id. Longest alias wins. */
export function resolveCatalogId(input: string): string | null {
  const text = ` ${input.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  let best: { id: string; len: number } | null = null;
  for (const entry of OBJECT_CATALOG) {
    for (const alias of [entry.id.replace(/_/g, " "), ...entry.aliases]) {
      if (text.includes(` ${alias} `) && (!best || alias.length > best.len)) best = { id: entry.id, len: alias.length };
    }
  }
  return best?.id ?? null;
}

export interface CountryInfo {
  name: string;
  aliases: string[];
  /** Name used by the Natural Earth dataset (for the outline highlight). */
  ne: string;
  lat: number;
  lon: number;
  capital: string;
  population: string;
  area: string;
}

export const COUNTRIES: CountryInfo[] = [
  { name: "India", aliases: ["india", "bharat"], ne: "India", lat: 22.5, lon: 79, capital: "New Delhi", population: "1.43 billion", area: "3.29 million km²" },
  { name: "United States", aliases: ["united states", "usa", "us", "america", "united states of america"], ne: "United States of America", lat: 39.8, lon: -98.6, capital: "Washington, D.C.", population: "335 million", area: "9.83 million km²" },
  { name: "Canada", aliases: ["canada"], ne: "Canada", lat: 56.1, lon: -106.3, capital: "Ottawa", population: "40 million", area: "9.98 million km²" },
  { name: "Mexico", aliases: ["mexico"], ne: "Mexico", lat: 23.6, lon: -102.5, capital: "Mexico City", population: "129 million", area: "1.96 million km²" },
  { name: "Brazil", aliases: ["brazil"], ne: "Brazil", lat: -14.2, lon: -51.9, capital: "Brasília", population: "216 million", area: "8.52 million km²" },
  { name: "Argentina", aliases: ["argentina"], ne: "Argentina", lat: -38.4, lon: -63.6, capital: "Buenos Aires", population: "46 million", area: "2.78 million km²" },
  { name: "United Kingdom", aliases: ["united kingdom", "uk", "britain", "great britain", "england"], ne: "United Kingdom", lat: 54.5, lon: -2.5, capital: "London", population: "68 million", area: "243,610 km²" },
  { name: "France", aliases: ["france"], ne: "France", lat: 46.2, lon: 2.2, capital: "Paris", population: "68 million", area: "551,695 km²" },
  { name: "Germany", aliases: ["germany"], ne: "Germany", lat: 51.2, lon: 10.4, capital: "Berlin", population: "84 million", area: "357,022 km²" },
  { name: "Italy", aliases: ["italy"], ne: "Italy", lat: 42.8, lon: 12.6, capital: "Rome", population: "59 million", area: "301,340 km²" },
  { name: "Spain", aliases: ["spain"], ne: "Spain", lat: 40.5, lon: -3.7, capital: "Madrid", population: "48 million", area: "505,990 km²" },
  { name: "Russia", aliases: ["russia"], ne: "Russia", lat: 61.5, lon: 99, capital: "Moscow", population: "144 million", area: "17.1 million km²" },
  { name: "China", aliases: ["china"], ne: "China", lat: 35.9, lon: 104.2, capital: "Beijing", population: "1.41 billion", area: "9.6 million km²" },
  { name: "Japan", aliases: ["japan"], ne: "Japan", lat: 36.2, lon: 138.3, capital: "Tokyo", population: "124 million", area: "377,975 km²" },
  { name: "South Korea", aliases: ["south korea", "korea"], ne: "South Korea", lat: 35.9, lon: 127.8, capital: "Seoul", population: "52 million", area: "100,210 km²" },
  { name: "Pakistan", aliases: ["pakistan"], ne: "Pakistan", lat: 30.4, lon: 69.3, capital: "Islamabad", population: "241 million", area: "881,913 km²" },
  { name: "Bangladesh", aliases: ["bangladesh"], ne: "Bangladesh", lat: 23.7, lon: 90.4, capital: "Dhaka", population: "173 million", area: "147,570 km²" },
  { name: "Nepal", aliases: ["nepal"], ne: "Nepal", lat: 28.4, lon: 84.1, capital: "Kathmandu", population: "30 million", area: "147,181 km²" },
  { name: "Sri Lanka", aliases: ["sri lanka"], ne: "Sri Lanka", lat: 7.9, lon: 80.8, capital: "Sri Jayawardenepura Kotte", population: "22 million", area: "65,610 km²" },
  { name: "Indonesia", aliases: ["indonesia"], ne: "Indonesia", lat: -2.5, lon: 118, capital: "Jakarta", population: "278 million", area: "1.9 million km²" },
  { name: "Australia", aliases: ["australia"], ne: "Australia", lat: -25.3, lon: 133.8, capital: "Canberra", population: "27 million", area: "7.69 million km²" },
  { name: "New Zealand", aliases: ["new zealand"], ne: "New Zealand", lat: -40.9, lon: 174.9, capital: "Wellington", population: "5.2 million", area: "268,021 km²" },
  { name: "Egypt", aliases: ["egypt"], ne: "Egypt", lat: 26.8, lon: 30.8, capital: "Cairo", population: "113 million", area: "1.0 million km²" },
  { name: "South Africa", aliases: ["south africa"], ne: "South Africa", lat: -30.6, lon: 22.9, capital: "Pretoria", population: "62 million", area: "1.22 million km²" },
  { name: "Nigeria", aliases: ["nigeria"], ne: "Nigeria", lat: 9.1, lon: 8.7, capital: "Abuja", population: "224 million", area: "923,768 km²" },
  { name: "Kenya", aliases: ["kenya"], ne: "Kenya", lat: 0.2, lon: 37.9, capital: "Nairobi", population: "55 million", area: "580,367 km²" },
  { name: "Saudi Arabia", aliases: ["saudi arabia", "saudi"], ne: "Saudi Arabia", lat: 23.9, lon: 45.1, capital: "Riyadh", population: "33 million", area: "2.15 million km²" },
  { name: "United Arab Emirates", aliases: ["united arab emirates", "uae", "emirates", "dubai"], ne: "United Arab Emirates", lat: 23.4, lon: 53.8, capital: "Abu Dhabi", population: "10 million", area: "83,600 km²" },
  { name: "Turkey", aliases: ["turkey", "turkiye"], ne: "Turkey", lat: 39, lon: 35.2, capital: "Ankara", population: "85 million", area: "783,562 km²" },
  { name: "Iran", aliases: ["iran"], ne: "Iran", lat: 32.4, lon: 53.7, capital: "Tehran", population: "89 million", area: "1.65 million km²" },
  { name: "Thailand", aliases: ["thailand"], ne: "Thailand", lat: 15.9, lon: 101, capital: "Bangkok", population: "71 million", area: "513,120 km²" },
  { name: "Vietnam", aliases: ["vietnam"], ne: "Vietnam", lat: 16, lon: 106.5, capital: "Hanoi", population: "99 million", area: "331,212 km²" },
  { name: "Singapore", aliases: ["singapore"], ne: "Singapore", lat: 1.35, lon: 103.8, capital: "Singapore", population: "5.9 million", area: "734 km²" },
];

export function resolveCountry(input: string): CountryInfo | null {
  const text = ` ${input.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  let best: { c: CountryInfo; len: number } | null = null;
  for (const c of COUNTRIES) {
    for (const alias of c.aliases) {
      if (text.includes(` ${alias} `) && (!best || alias.length > best.len)) best = { c, len: alias.length };
    }
  }
  return best?.c ?? null;
}
