// Initial configuration
const linesConfig = window.linesConfig || [];

// Configuration constants
const CONFIG = {
  REFRESH: {
    FOLLOWING_MS: 2000,
    NORMAL_MS: 3000,
    MANY_LINES_MS: 5000,
    MANY_LINES_THRESHOLD: 10,
    TRACK_REFRESH_INTERVAL: 6
  },
  CACHE: {
    STOP_RUNS_TTL_MS: 5000
  },
  UI: {
    TOAST_DURATION_MS: 3000,
    SMALL_ICON_THRESHOLD: 10,
    BUS_ICON_SCALE_MAX: 1.2,
    DIRECTIONS_EMPTY_AFTER_MS: 30000,
  },
  MAP: {
    DEFAULT_CENTER: [45.653, 13.776],
    DEFAULT_ZOOM: 14,
    FOLLOW_ZOOM: 15
  }
};

// Static track coordinates for Easter Egg line 777
const easterEggTrack777 = [
  [45.651935, 13.773043], // Canal Grande Trieste
  [45.653091, 13.769098],
  [45.653535, 13.765801],
  [45.553794, 13.09220],
  [45.418835, 12.435624],
  [45.433784, 12.402343],
  [45.435350, 12.387535],
  [45.433848, 12.383699],
  [45.423099, 12.370691],
  [45.422033, 12.366322],
  [45.422757, 12.362378],
  [45.432441, 12.346999],
  [45.432508, 12.341332],
  [45.431358, 12.333801],
  [45.431367, 12.330536],
  [45.431688, 12.328907],
  [45.432614, 12.327703],
  [45.434557, 12.327197],
  [45.435488, 12.329295],
  [45.437289, 12.334968],
  [45.438531, 12.336207],
  [45.439543, 12.335579],
  [45.440329, 12.334030],
  [45.442156, 12.330163],
  [45.442325, 12.329644] // Casinò Venezia
];

const normalizeKey = (value) => String(value || '').trim().toUpperCase();

const BUS_PALETTE = [
  "#b80000",
  "#0086b3",
  "#b8002e",
  "#008f8f",
  "#b30059",
  "#008f00",
  "#7800f0",
  "#478f00",
  "#9500c7",
  "#8f8f00",
  "#0059b3",
  "#8f4700",
  "#008f6b",
  "#a300a3",
  "#008f47",
  "#8f6b00"
];

const LEGEND_GROUPS = {
  UNI: {
    '17': ['SAN CILINO'],
    '17/': ['SAN CILINO'],
    '4': ['VILLA CARSIA'],
    '3': ['CONCONELLO'],
    '51': ['VILLA CARSIA', 'STAZIONE FERROVIARIA']
  },
  FS: {
    '17/': ['STAZIONE FERROVIARIA'],
    '17': ['VIA DI CAMPO MARZIO'],
    '4': ['PIAZZA OBERDAN', 'PIAZZA TOMMASEO'],
    '51': ['STAZIONE FERROVIARIA'],
    '3': ['STAZIONE FERROVIARIA']
  }
};

class BusMagoApp {
  constructor() {
    this.state = {
      busMarkers: {}, // key -> L.marker
      vehicleState: {}, // key -> { lat, lon, heading, lastEnrichedBus }
      selectedVehicleKey: null,
      lineVisibility: {},
      lastEnrichedBuses: [],
      routeLayers: {}, // key -> L.polyline
      routeEndpointMarkers: {}, // key -> array of markers
      lastRaces: {},
      trackRefreshCounters: {},
      visibleTrackKeys: new Set(),
      userHasInteracted: false,
      isFollowing: false,
      suppressMenuAutoClose: false,
      map: null,
      easterEgg: {
        active: false,
        marker: null,
        interval: null,
        index: 0
      },
      stopCache: {
        entries: {},
        inFlight: {}
      },
      lastInfoSignature: null,
      favorites: {
        key: 'busmago:favorites:v2',
        set: new Set(),
        snapshot: null
      },
      theme: {
        key: 'busmago:theme:v1',
        mode: 'dark'
      },
      legend: {
        filterText: '',
        viewMode: 'grid',
        viewKey: 'busmago:legendView:v1',
        groupKeys: new Set(),
        groupKeysStorageKey: 'busmago:legendGroupKeys:v1'
      },
      directions: {
        knownByLine: {},
        filterByLine: {},
        defaultFilterByLine: {},
        overrideModeByLine: {},
        expandedLineCode: null,
        waitStartedAtByLine: {},
        lastKnownSignature: ''
      },
      legendPaletteIndexByCode: {},
      persisted: {
        activeLinesKey: 'busmago:activeLines:v2'
      },
      updateStatus: {
        lastSuccessAt: 0,
        lastErrorAt: 0,
        lastErrorMessage: '',
        lastSelectedMoveAt: 0
      },
      uiTimers: {
        infoAgeInterval: null,
        refreshTimeout: null,
        directionsStatusTimeout: null
      },
      refreshControl: {
        inFlight: false,
        requestSeq: 0,
        lastAppliedRequestSeq: 0
      }
    };

    // DOM Elements
    this.infoDiv = document.querySelector('.info');
    this.legendDiv = document.getElementById('legend');
    this.toastDiv = null;

    // Bindings
    this.refreshData = this.refreshData.bind(this);
  }

  escapeHtmlAttribute(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  getContrastingTextColor(color) {
    const c = String(color || '').trim();
    let r = 0;
    let g = 0;
    let b = 0;

    if (c.startsWith('#')) {
      const hex = c.slice(1);
      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
      } else if (hex.length === 6) {
        r = parseInt(hex.slice(0, 2), 16);
        g = parseInt(hex.slice(2, 4), 16);
        b = parseInt(hex.slice(4, 6), 16);
      } else {
        return '#fff';
      }
    } else if (c.startsWith('rgb')) {
      const m = c.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
      if (!m) return '#fff';
      r = parseInt(m[1], 10);
      g = parseInt(m[2], 10);
      b = parseInt(m[3], 10);
    } else {
      return '#fff';
    }

    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.62 ? '#111' : '#fff';
  }

  hslToHex(h, s, l) {
    const hh = (((h % 360) + 360) % 360) / 360;
    const ss = Math.max(0, Math.min(1, s / 100));
    const ll = Math.max(0, Math.min(1, l / 100));

    const hue2rgb = (p, q, t) => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };

    let r;
    let g;
    let b;

    if (ss === 0) {
      r = ll;
      g = ll;
      b = ll;
    } else {
      const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
      const p = 2 * ll - q;
      r = hue2rgb(p, q, hh + 1 / 3);
      g = hue2rgb(p, q, hh);
      b = hue2rgb(p, q, hh - 1 / 3);
    }

    const toHex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  getLegendLineColor(code) {
    const rawCode = String(code ?? '');
    const colorRotation = { '51': '56', '56': '58', '58': '51', '4': '9', '9': '4' };
    const sourceCode = colorRotation[rawCode] ?? rawCode;
    const idx = this.state.legendPaletteIndexByCode[sourceCode] ?? 0;
    const palette = BUS_PALETTE;
    if (!Array.isArray(palette) || palette.length === 0) return '#0077ff';
    return palette[((idx % palette.length) + palette.length) % palette.length];
  }

  recomputeGroupDefaultFilters() {
    const active = this.state.legend && this.state.legend.groupKeys instanceof Set ? this.state.legend.groupKeys : new Set();
    const out = {};
    active.forEach(key => {
      if (key !== 'UNI' && key !== 'FS') return;
      const group = LEGEND_GROUPS[key];
      if (!group || typeof group !== 'object') return;
      Object.keys(group).forEach(lineCode => {
        const dests = group[lineCode];
        if (!Array.isArray(dests) || dests.length === 0) return;
        const lc = String(lineCode);
        if (!out[lc]) out[lc] = new Set();
        dests.forEach(d => {
          const dk = normalizeKey(d);
          if (dk) out[lc].add(dk);
        });
      });
    });
    this.state.directions.defaultFilterByLine = out;
  }

  applyGroupLineSelections() {
    const active = this.state.legend && this.state.legend.groupKeys instanceof Set ? this.state.legend.groupKeys : new Set();
    const now = Date.now();
    active.forEach(key => {
      if (key !== 'UNI' && key !== 'FS') return;
      const group = LEGEND_GROUPS[key];
      if (!group || typeof group !== 'object') return;
      Object.keys(group).forEach(lineCode => {
        const lc = String(lineCode);
        if (!Object.prototype.hasOwnProperty.call(this.state.lineVisibility, lc)) return;
        this.state.lineVisibility[lc] = true;
        if (!this.state.directions.waitStartedAtByLine[lc]) this.state.directions.waitStartedAtByLine[lc] = now;
      });
    });
  }

  toggleLegendGroupKey(key) {
    const k = key === 'UNI' || key === 'FS' ? key : null;
    if (!k) return;
    if (!(this.state.legend.groupKeys instanceof Set)) this.state.legend.groupKeys = new Set();
    if (this.state.legend.groupKeys.has(k)) this.state.legend.groupKeys.delete(k);
    else this.state.legend.groupKeys.add(k);
    this.recomputeGroupDefaultFilters();
    this.applyGroupLineSelections();
    this.saveLegendGroupKeys();
  }

  loadLegendView() {
    try {
      const raw = localStorage.getItem(this.state.legend.viewKey);
      if (raw === 'grid' || raw === 'list') this.state.legend.viewMode = raw;
    } catch {
    }
  }

  saveLegendView() {
    try {
      localStorage.setItem(this.state.legend.viewKey, this.state.legend.viewMode);
    } catch {
    }
  }

  loadLegendGroupKeys() {
    if (!(this.state.legend.groupKeys instanceof Set)) this.state.legend.groupKeys = new Set();
    try {
      const raw = localStorage.getItem(this.state.legend.groupKeysStorageKey);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          arr.forEach(k => {
            if (k === 'UNI' || k === 'FS') this.state.legend.groupKeys.add(k);
          });
        }
      }
    } catch {
    }

    try {
      const legacy = localStorage.getItem('busmago:legendGroupKey:v1');
      if (legacy === 'UNI' || legacy === 'FS') this.state.legend.groupKeys.add(legacy);
    } catch {
    }
  }

  saveLegendGroupKeys() {
    try {
      const active = this.state.legend.groupKeys instanceof Set ? Array.from(this.state.legend.groupKeys) : [];
      const filtered = active.filter(k => k === 'UNI' || k === 'FS');
      if (filtered.length > 0) {
        localStorage.setItem(this.state.legend.groupKeysStorageKey, JSON.stringify(filtered));
      } else {
        localStorage.removeItem(this.state.legend.groupKeysStorageKey);
      }
    } catch {
    }
  }

  init() {
    this.loadTheme();
    this.loadFavorites();
    this.initMap();
    this.initToast();
    this.initVisibility();
    this.loadActiveLines();
    this.loadLegendView();
    this.loadLegendGroupKeys();
    this.recomputeGroupDefaultFilters();
    this.applyGroupLineSelections();
    const now = Date.now();
    Object.keys(this.state.lineVisibility).forEach(lineCode => {
      if (this.state.lineVisibility[lineCode] === true && !this.state.directions.waitStartedAtByLine[lineCode]) {
        this.state.directions.waitStartedAtByLine[lineCode] = now;
      }
    });
    this.renderLegend();
    this.setupEvents();
    this.initUserLocation();

    // Start loop
    this.scheduleNextRefresh(0);

    this.state.uiTimers.infoAgeInterval = setInterval(() => {
      if (this.state.selectedVehicleKey) this.updateInfoAgeBadge();
    }, 1000);
  }

  initMap() {
    this.state.map = L.map('map', { zoomControl: false }).setView(CONFIG.MAP.DEFAULT_CENTER, CONFIG.MAP.DEFAULT_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
      maxZoom: 19, 
      attribution: '&copy; OpenStreetMap contributors',
      className: this.state.theme.mode === 'dark' ? 'dark-mode-tiles' : '',
      keepBuffer: 15,
      updateWhenIdle: false,
      updateWhenZooming: false,
      fadeAnimation: false
    }).addTo(this.state.map);
    L.control.zoom({ position: 'bottomright' }).addTo(this.state.map);
  }

  loadTheme() {
    try {
      const raw = localStorage.getItem(this.state.theme.key);
      if (raw === 'light' || raw === 'dark') this.state.theme.mode = raw;
    } catch {
    }
    document.documentElement.dataset.theme = this.state.theme.mode;
  }

  setTheme(mode) {
    if (mode !== 'light' && mode !== 'dark') return;
    this.state.theme.mode = mode;
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem(this.state.theme.key, mode);
    } catch {
    }

    const btn = document.getElementById('theme-toggle-btn');
    if (btn) btn.textContent = mode === 'dark' ? '🌙' : '☀️';

    const map = this.state.map;
    if (map) {
      map.eachLayer(layer => {
        if (layer && layer.options && typeof layer.setUrl === 'function') {
          layer.options.className = mode === 'dark' ? 'dark-mode-tiles' : '';
          if (layer.getContainer) {
            const c = layer.getContainer();
            if (c) c.className = layer.options.className;
          }
        }
      });
    }

    this.renderLegend();
    this.updateBusMarkers(this.state.lastEnrichedBuses);
  }

  loadFavorites() {
    try {
      const raw = localStorage.getItem(this.state.favorites.key);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) this.state.favorites.set = new Set(arr.filter(x => typeof x === 'string'));
        return;
      }

      const legacyRaw = localStorage.getItem('busmago:favorites:v1');
      if (!legacyRaw) return;
      const legacyArr = JSON.parse(legacyRaw);
      if (!Array.isArray(legacyArr)) return;

      const migrated = new Set();
      legacyArr.forEach(x => {
        if (typeof x !== 'string') return;
        const label = x.includes(' - ') ? x.split(' - ')[0].trim() : x.trim();
        const line = linesConfig.find(l => l.code === label || l.label === label);
        if (line) migrated.add(line.code);
      });

      this.state.favorites.set = migrated;
      try {
        localStorage.setItem(this.state.favorites.key, JSON.stringify(Array.from(migrated)));
      } catch {
      }
    } catch {
    }
  }

  saveFavorites() {
    try {
      localStorage.setItem(this.state.favorites.key, JSON.stringify(Array.from(this.state.favorites.set)));
    } catch {
    }
  }

  saveActiveLines() {
    try {
      const active = Object.keys(this.state.lineVisibility).filter(k => this.state.lineVisibility[k] === true);
      localStorage.setItem(this.state.persisted.activeLinesKey, JSON.stringify(active));
    } catch {
    }
  }

  loadActiveLines() {
    try {
      const raw = localStorage.getItem(this.state.persisted.activeLinesKey);
      if (raw) {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return;
        const set = new Set(arr.filter(x => typeof x === 'string'));
        Object.keys(this.state.lineVisibility).forEach(k => {
          this.state.lineVisibility[k] = set.has(k);
        });
        return;
      }

      const legacyRaw = localStorage.getItem('busmago:activeLines:v1');
      if (!legacyRaw) return;
      const legacyArr = JSON.parse(legacyRaw);
      if (!Array.isArray(legacyArr)) return;

      const migrated = new Set();
      legacyArr.forEach(x => {
        if (typeof x !== 'string') return;
        const label = x.includes(' - ') ? x.split(' - ')[0].trim() : x.trim();
        const line = linesConfig.find(l => l.code === label || l.label === label);
        if (line) migrated.add(line.code);
      });

      Object.keys(this.state.lineVisibility).forEach(k => {
        this.state.lineVisibility[k] = migrated.has(k);
      });

      try {
        localStorage.setItem(this.state.persisted.activeLinesKey, JSON.stringify(Array.from(migrated)));
      } catch {
      }
    } catch {
    }
  }

  toggleFavorite(key) {
    if (this.state.favorites.set.has(key)) this.state.favorites.set.delete(key);
    else this.state.favorites.set.add(key);
    this.saveFavorites();
    this.renderLegend();
  }

  async fetchStopRuns(stopCode) {
    const now = Date.now();
    const cached = this.state.stopCache.entries[stopCode];
    if (cached && cached.expiresAt > now) return cached.data;

    const inFlight = this.state.stopCache.inFlight[stopCode];
    if (inFlight) return inFlight;

    const p = fetch(`https://realtime.tplfvg.it/API/v1.0/polemonitor/mrcruns?StopCode=${stopCode}&IsUrban=true&_=${now}`)
      .then(r => r.json())
      .then(data => {
        const normalized = Array.isArray(data) ? data : [];
        this.state.stopCache.entries[stopCode] = { data: normalized, expiresAt: now + CONFIG.CACHE.STOP_RUNS_TTL_MS };
        return normalized;
      })
      .catch(() => {
        const fallback = cached ? cached.data : [];
        this.state.stopCache.entries[stopCode] = { data: fallback, expiresAt: now + 1000 };
        return fallback;
      })
      .finally(() => {
        delete this.state.stopCache.inFlight[stopCode];
      });

    this.state.stopCache.inFlight[stopCode] = p;
    return p;
  }

  initToast() {
    this.toastDiv = document.createElement('div');
    this.toastDiv.className = 'toast-notification';
    document.body.appendChild(this.toastDiv);
  }

  showToast(message, type = 'info') {
    if (!this.toastDiv) return;
    this.toastDiv.textContent = message;
    this.toastDiv.className = `toast-notification show ${type}`;
    // Hide after timeout
    setTimeout(() => {
        if (this.toastDiv) this.toastDiv.classList.remove('show');
    }, CONFIG.UI.TOAST_DURATION_MS);
  }

  initVisibility() {
    linesConfig.forEach((l, idx) => {
      this.state.lineVisibility[l.code] = false;
      this.state.legendPaletteIndexByCode[l.code] = idx;
    });

    const idx3 = this.state.legendPaletteIndexByCode['3'];
    const idx10 = this.state.legendPaletteIndexByCode['10'];
    if (typeof idx3 === 'number' && typeof idx10 === 'number') {
      this.state.legendPaletteIndexByCode['3'] = idx10;
      this.state.legendPaletteIndexByCode['10'] = idx3;
    }
  }

  setupEvents() {
    const map = this.state.map;

    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) {
      themeBtn.textContent = this.state.theme.mode === 'dark' ? '🌙' : '☀️';
      themeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setTheme(this.state.theme.mode === 'dark' ? 'light' : 'dark');
      });
    }

    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.scheduleNextRefresh(0);
      });
    }
    
    // Map interaction
    map.on('zoomstart', () => this.handleInteraction());
    map.on('zoomend', () => {
      if (this.state.map) this.updateBusMarkers(this.state.lastEnrichedBuses);
    });
    map.on('dragstart', () => {
        this.handleInteraction();
        this.state.isFollowing = false;
    });
    map.on('click', () => {
      this.handleInteraction();
      this.deselectVehicle();
      this.state.isFollowing = false;
    });

    // Menu toggle
    const menuToggle = document.getElementById('menu-toggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', (e) => {
            if (e) {
              e.preventDefault();
              e.stopPropagation();
            }
            const willShow = !this.isLegendVisible();
            this.legendDiv.style.display = willShow ? 'block' : 'none';
            if (willShow) this.renderLegend();
        });
    }
  }

  isLegendVisible() {
    if (!this.legendDiv) return false;
    const s = window.getComputedStyle(this.legendDiv);
    return s && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  updateKnownDirectionsFromBuses(buses) {
    const nextKnown = {};

    (Array.isArray(buses) ? buses : []).forEach(b => {
      if (!b || !b.lineCode) return;
      if (this.state.lineVisibility[b.lineCode] !== true) return;
      const destRaw = String(b.destination || '').trim();
      const destKey = normalizeKey(destRaw);
      if (!destKey) return;

      if (!nextKnown[b.lineCode]) nextKnown[b.lineCode] = {};
      if (!nextKnown[b.lineCode][destKey]) nextKnown[b.lineCode][destKey] = destRaw || destKey;
    });

    this.setKnownDirections(nextKnown);
  }

  updateKnownDirectionsFromStopData(stopDataMap) {
    const nextKnown = {};

    linesConfig.forEach(lineConf => {
      if (!lineConf || !lineConf.code) return;
      if (this.state.lineVisibility[lineConf.code] !== true) return;

      const stops = Array.isArray(lineConf.stops) ? lineConf.stops : [];
      stops.forEach(sCode => {
        const runs = stopDataMap && stopDataMap[sCode];
        if (!Array.isArray(runs)) return;
        runs.forEach(r => {
          if (((r.LineCode || '').toUpperCase()) !== lineConf.code) return;
          const lat = Number(r.Latitude || 0);
          const lon = Number(r.Longitude || 0);
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) return;
          const destRaw = String(r.Destination || '').trim();
          const destKey = normalizeKey(destRaw);
          if (!destKey) return;

          if (!nextKnown[lineConf.code]) nextKnown[lineConf.code] = {};
          if (!nextKnown[lineConf.code][destKey]) nextKnown[lineConf.code][destKey] = destRaw || destKey;
        });
      });
    });

    this.setKnownDirections(nextKnown);
  }

  setKnownDirections(nextKnown) {
    const signatureParts = [];
    Object.keys(nextKnown).sort().forEach(lineCode => {
      const obj = nextKnown[lineCode];
      Object.keys(obj).sort().forEach(destKey => {
        signatureParts.push(`${lineCode}|${destKey}|${obj[destKey]}`);
      });
    });
    const nextSignature = signatureParts.join('||');
    const prevSignature = this.state.directions.lastKnownSignature || '';

    this.state.directions.knownByLine = nextKnown;
    this.state.directions.lastKnownSignature = nextSignature;

    const filterByLine = this.state.directions.filterByLine || {};
    const modeByLine = this.state.directions.overrideModeByLine || {};
    Object.keys(filterByLine).forEach(lineCode => {
      const set = filterByLine[lineCode];
      if (!(set instanceof Set)) return;
      const knownForLine = nextKnown[lineCode] || null;
      const knownKeys = knownForLine ? Object.keys(knownForLine) : [];
      if (!knownForLine || knownKeys.length <= 1) {
        delete filterByLine[lineCode];
        if (modeByLine[lineCode] === 'set') delete modeByLine[lineCode];
        return;
      }
      const nextSet = new Set();
      knownKeys.forEach(k => {
        if (set.has(k)) nextSet.add(k);
      });
      if (nextSet.size === 0) {
        delete filterByLine[lineCode];
        if (modeByLine[lineCode] === 'set') modeByLine[lineCode] = 'all';
      } else {
        filterByLine[lineCode] = nextSet;
      }
    });

    if (nextSignature !== prevSignature && this.isLegendVisible()) {
      this.renderLegend();
    }
  }

  isDirectionAllowed(lineCode, destination) {
    const directions = this.state.directions || {};
    const modeByLine = directions.overrideModeByLine && typeof directions.overrideModeByLine === 'object' ? directions.overrideModeByLine : {};
    const mode = modeByLine[lineCode];
    if (mode === 'all') return true;

    const filterByLine = directions.filterByLine && typeof directions.filterByLine === 'object' ? directions.filterByLine : {};
    const defaultByLine = directions.defaultFilterByLine && typeof directions.defaultFilterByLine === 'object' ? directions.defaultFilterByLine : {};
    const baseSet = mode === 'set' ? filterByLine[lineCode] : defaultByLine[lineCode];
    if (!(baseSet instanceof Set) || baseSet.size === 0) return true;

    const known = directions.knownByLine && typeof directions.knownByLine === 'object' ? directions.knownByLine[lineCode] : null;
    const knownKeys = known && typeof known === 'object' ? Object.keys(known) : [];
    if (knownKeys.length > 0) {
      const knownSet = new Set(knownKeys);
      let anyPresent = false;
      baseSet.forEach(k => { if (knownSet.has(k)) anyPresent = true; });
      if (!anyPresent) return false;
    }

    const destKey = normalizeKey(destination);
    return baseSet.has(destKey);
  }

  toggleDirectionFilter(lineCode, destKey) {
    if (!lineCode) return;
    const key = normalizeKey(destKey);
    if (!key) return;

    if (!this.state.directions.filterByLine) this.state.directions.filterByLine = {};
    if (!this.state.directions.overrideModeByLine) this.state.directions.overrideModeByLine = {};

    const mode = this.state.directions.overrideModeByLine[lineCode];
    const existing = this.state.directions.filterByLine[lineCode];
    const defaultSet = this.state.directions.defaultFilterByLine && this.state.directions.defaultFilterByLine[lineCode] instanceof Set
      ? this.state.directions.defaultFilterByLine[lineCode]
      : null;

    let next;
    if (mode === 'all') {
      next = new Set();
    } else if (mode === 'set') {
      next = existing instanceof Set ? new Set(existing) : (defaultSet instanceof Set ? new Set(defaultSet) : new Set());
    } else {
      next = defaultSet instanceof Set ? new Set(defaultSet) : new Set();
    }

    if (next.has(key)) next.delete(key);
    else next.add(key);

    const knownForLine = this.state.directions.knownByLine && this.state.directions.knownByLine[lineCode] ? this.state.directions.knownByLine[lineCode] : null;
    const knownKeys = knownForLine && typeof knownForLine === 'object' ? Object.keys(knownForLine) : [];
    if (knownKeys.length > 0 && next.size >= knownKeys.length) {
      delete this.state.directions.filterByLine[lineCode];
      this.state.directions.overrideModeByLine[lineCode] = 'all';
      return;
    }

    if (next.size === 0) {
      delete this.state.directions.filterByLine[lineCode];
      this.state.directions.overrideModeByLine[lineCode] = 'all';
    } else {
      this.state.directions.filterByLine[lineCode] = next;
      this.state.directions.overrideModeByLine[lineCode] = 'set';
    }
  }

  clearDirectionFilter(lineCode) {
    if (!lineCode) return;
    if (!this.state.directions.overrideModeByLine) this.state.directions.overrideModeByLine = {};
    this.state.directions.overrideModeByLine[lineCode] = 'all';
    if (this.state.directions.filterByLine && this.state.directions.filterByLine[lineCode]) delete this.state.directions.filterByLine[lineCode];
  }

  handleInteraction() {
    if (this.state.suppressMenuAutoClose) return;
    this.state.userHasInteracted = true;
    if (this.legendDiv.style.display === 'block') {
      this.legendDiv.style.display = 'none';
    }
  }

  suppressMenuAutoCloseUntilMapSettles() {
    this.state.suppressMenuAutoClose = true;
    const map = this.state.map;
    let cleared = false;
    const clear = () => {
      if (cleared) return;
      cleared = true;
      this.state.suppressMenuAutoClose = false;
    };

    if (map) {
      map.once('moveend', clear);
      map.once('zoomend', clear);
    }

    setTimeout(clear, 1200);
  }

  deselectVehicle() {
    if (this.state.selectedVehicleKey) {
      this.state.selectedVehicleKey = null;
      this.updateInfoFromBus(null);
      this.updateBusMarkers(this.state.lastEnrichedBuses);
    }
  }

  initUserLocation() {
    if ("geolocation" in navigator) {
      let userMarker = null;
      let userAccuracyCircle = null;
      let firstLocationUpdate = true;
      let lastLat = null;
      let lastLon = null;
  
      navigator.geolocation.watchPosition(position => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        const accuracy = position.coords.accuracy;
        
        lastLat = lat;
        lastLon = lon;
  
        if (userMarker) {
          userMarker.setLatLng([lat, lon]);
          userAccuracyCircle.setLatLng([lat, lon]);
          userAccuracyCircle.setRadius(accuracy);
        } else {
          userMarker = L.marker([lat, lon], {
            icon: L.divIcon({
              className: 'user-location-marker',
              html: '<div style="background-color: #0077ff; width: 14px; height: 14px; border-radius: 50%; border: 3px solid #fff; box-shadow: 0 0 10px rgba(0,119,255,0.6);"></div>',
              iconSize: [20, 20],
              iconAnchor: [10, 10]
            })
          }).addTo(this.state.map).bindPopup("Areo qua! 📍");
          
          userAccuracyCircle = L.circle([lat, lon], {
            color: '#0077ff',
            fillColor: '#0077ff',
            fillOpacity: 0.15,
            radius: accuracy,
            weight: 1
          }).addTo(this.state.map);
        }
        
        if (firstLocationUpdate) {
          this.suppressMenuAutoCloseUntilMapSettles();
          this.state.map.setView([lat, lon], 15);
          firstLocationUpdate = false;
        }
      }, error => {
        console.warn("Geolocation access denied or error: " + error.message);
      }, {
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 10000
      });
      
      // Recenter button logic
      const recenterBtn = document.getElementById('recenter-btn');
      if (recenterBtn) {
        recenterBtn.style.display = 'flex';
        recenterBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (lastLat !== null && lastLon !== null) {
            this.suppressMenuAutoCloseUntilMapSettles();
            this.state.map.setView([lastLat, lastLon], 15);
          } else {
            this.showToast("Posizione non ancora rilevata. Controlla i permessi.", "error");
          }
        });
      }
    }
  }

  renderLegend() {
    if (!this.legendDiv) return;
    const prevScrollTop = this.legendDiv.scrollTop;
    const activeEl = document.activeElement;
    const wasSearchFocused = !!(activeEl && activeEl.id === 'legend-search');
    const searchSelStart = wasSearchFocused ? activeEl.selectionStart : null;
    const searchSelEnd = wasSearchFocused ? activeEl.selectionEnd : null;
    let html = "";
    if (this.state.uiTimers.directionsStatusTimeout) {
      clearTimeout(this.state.uiTimers.directionsStatusTimeout);
      this.state.uiTimers.directionsStatusTimeout = null;
    }
    
    const favoritesOnly = this.legendDiv.dataset.favoritesOnly === '1';
    const viewMode = this.state.legend.viewMode === 'list' ? 'list' : 'grid';
    const filterValue = (this.state.legend.filterText || '').trim();
    const iconTarget = viewMode === 'grid' ? 'list' : 'grid';
    const iconLabel = iconTarget === 'list' ? 'Passa a lista' : 'Passa a griglia';
    const svgGrid = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g fill="currentColor"><rect x="3" y="3" width="4" height="4" rx="1"/><rect x="10" y="3" width="4" height="4" rx="1"/><rect x="17" y="3" width="4" height="4" rx="1"/><rect x="3" y="10" width="4" height="4" rx="1"/><rect x="10" y="10" width="4" height="4" rx="1"/><rect x="17" y="10" width="4" height="4" rx="1"/><rect x="3" y="17" width="4" height="4" rx="1"/><rect x="10" y="17" width="4" height="4" rx="1"/><rect x="17" y="17" width="4" height="4" rx="1"/></g></svg>`;
    const svgList = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g fill="currentColor"><circle cx="6" cy="6" r="1.5"/><rect x="9" y="5" width="12" height="2" rx="1"/><circle cx="6" cy="12" r="1.5"/><rect x="9" y="11" width="12" height="2" rx="1"/><circle cx="6" cy="18" r="1.5"/><rect x="9" y="17" width="12" height="2" rx="1"/></g></svg>`;
    const iconSvg = iconTarget === 'list' ? svgList : svgGrid;

    html += `<div class="legend-search-row">
              <input id="legend-search" type="text" placeholder="Cerca linea..." value="${this.escapeHtmlAttribute(filterValue)}" class="legend-search">
            </div>`;

    html += `<button id="favorites-only-btn" class="legend-action-btn legend-action-toggle ${favoritesOnly ? 'is-active' : ''}" type="button" aria-pressed="${favoritesOnly ? 'true' : 'false'}">PREFERITI</button>`;

    const filterText = (this.state.legend.filterText || '').trim().toLowerCase();

    // Clear All Button
    html += `<button id="clear-all-lines">CLEAR ALL</button>`;

    const groupKeys = (this.state.legend && this.state.legend.groupKeys instanceof Set) ? this.state.legend.groupKeys : new Set();
    const uniActive = groupKeys.has('UNI');
    const fsActive = groupKeys.has('FS');
    html += `<hr class="legend-grid-separator">`;
    html += `<div class="legend-group-row">
              <button id="legend-group-uni" class="legend-action-btn legend-action-toggle legend-group-btn ${uniActive ? 'is-active' : ''}" type="button" aria-label="Gruppo UNI" aria-pressed="${uniActive ? 'true' : 'false'}"><img class="legend-group-icon" src="icona_uni.webp" alt=""></button>
              <button id="legend-group-fs" class="legend-action-btn legend-action-toggle legend-group-btn ${fsActive ? 'is-active' : ''}" type="button" aria-label="Gruppo FS" aria-pressed="${fsActive ? 'true' : 'false'}"><img class="legend-group-icon" src="icona_fs.webp" alt=""></button>
            </div>`;
    html += `<hr class="legend-grid-separator">`;

    const activeLineCodes = Object.keys(this.state.lineVisibility).filter(k => this.state.lineVisibility[k] === true);
    if (activeLineCodes.length > 0) {
      html += `<div class="legend-header-row">
                <div class="legend-section-title legend-chip">SELEZIONATE & DIREZIONI</div>
              </div>`;
      html += `<div class="selected-lines-panel">`;

      const expanded = this.state.directions ? this.state.directions.expandedLineCode : null;
      const knownByLine = (this.state.directions && this.state.directions.knownByLine) ? this.state.directions.knownByLine : {};
      const filterByLine = (this.state.directions && this.state.directions.filterByLine) ? this.state.directions.filterByLine : {};
      const defaultFilterByLine = (this.state.directions && this.state.directions.defaultFilterByLine) ? this.state.directions.defaultFilterByLine : {};
      const overrideModeByLine = (this.state.directions && this.state.directions.overrideModeByLine) ? this.state.directions.overrideModeByLine : {};
      const waitStartedAtByLine = (this.state.directions && this.state.directions.waitStartedAtByLine) ? this.state.directions.waitStartedAtByLine : {};
      const now = Date.now();
      let nextRerenderInMs = null;

      activeLineCodes.forEach(lineCode => {
        const lineColor = this.getLegendLineColor(lineCode);
        const known = knownByLine[lineCode] && typeof knownByLine[lineCode] === 'object' ? knownByLine[lineCode] : {};
        const userSet = filterByLine[lineCode] instanceof Set ? filterByLine[lineCode] : null;
        const defaultSet = defaultFilterByLine[lineCode] instanceof Set ? defaultFilterByLine[lineCode] : null;
        const overrideMode = overrideModeByLine && typeof overrideModeByLine === 'object' ? overrideModeByLine[lineCode] : null;

        const knownKeys = Object.keys(known);
        knownKeys.sort((a, b) => {
          const la = String(known[a] || a);
          const lb = String(known[b] || b);
          return la.localeCompare(lb);
        });

        let summary = 'Tutte';
        const knownSet = new Set(knownKeys);
        let effectiveSelectedSet = null;

        if (knownKeys.length === 0) {
          let startedAt = Number(waitStartedAtByLine[lineCode] || 0);
          if (!startedAt) {
            startedAt = now;
            waitStartedAtByLine[lineCode] = now;
          }
          const age = startedAt > 0 ? (now - startedAt) : 0;
          const remaining = CONFIG.UI.DIRECTIONS_EMPTY_AFTER_MS - age;
          if (remaining > 0) {
            nextRerenderInMs = nextRerenderInMs === null ? remaining : Math.min(nextRerenderInMs, remaining);
          }
          summary = age >= CONFIG.UI.DIRECTIONS_EMPTY_AFTER_MS ? 'Nessuna vettura in circolazione' : 'In attesa dati…';
        } else if (knownKeys.length === 1) {
          summary = String(known[knownKeys[0]] || knownKeys[0]);
        } else {
          let baseSet = null;
          if (overrideMode === 'all') baseSet = null;
          else if (overrideMode === 'set') baseSet = userSet;
          else baseSet = defaultSet;

          if (baseSet instanceof Set && baseSet.size > 0) {
            const presentSelected = new Set();
            baseSet.forEach(k => { if (knownSet.has(k)) presentSelected.add(k); });
            if (presentSelected.size > 0) {
              if (presentSelected.size >= knownKeys.length) effectiveSelectedSet = null;
              else effectiveSelectedSet = presentSelected;
            }
          }

          if (effectiveSelectedSet instanceof Set && effectiveSelectedSet.size > 0) {
            const selected = Array.from(effectiveSelectedSet);
            selected.sort((a, b) => {
              const la = String(known[a] || a);
              const lb = String(known[b] || b);
              return la.localeCompare(lb);
            });
            const first = selected[0];
            const firstLabel = String(known[first] || first);
            summary = selected.length > 1 ? `${firstLabel} +${selected.length - 1}` : firstLabel;
          }
        }

        const isExpandable = knownKeys.length >= 2;
        const isExpanded = isExpandable && expanded === lineCode;
        if (!isExpandable && this.state.directions.expandedLineCode === lineCode) this.state.directions.expandedLineCode = null;

        html += `<div class="selected-line-tile" style="--line-color:${lineColor};">`;
        if (isExpandable) {
          html += `<button type="button" class="selected-line-toggle" data-line="${this.escapeHtmlAttribute(lineCode)}" aria-expanded="${isExpanded ? 'true' : 'false'}">
                    <span class="selected-line-code">${this.escapeHtmlAttribute(lineCode)}</span>
                    <span class="selected-line-meta">${this.escapeHtmlAttribute(summary)}</span>
                    <span class="selected-line-chevron" aria-hidden="true"></span>
                  </button>`;
        } else {
          html += `<div class="selected-line-static" aria-label="Linea ${this.escapeHtmlAttribute(lineCode)}">
                    <span class="selected-line-code">${this.escapeHtmlAttribute(lineCode)}</span>
                    <span class="selected-line-meta">${this.escapeHtmlAttribute(summary)}</span>
                    <span class="selected-line-spacer" aria-hidden="true"></span>
                  </div>`;
        }

        if (isExpanded) {
          const allActive = !(effectiveSelectedSet instanceof Set && effectiveSelectedSet.size > 0);
          html += `<div class="selected-line-menu" role="group" aria-label="Direzioni ${this.escapeHtmlAttribute(lineCode)}">`;
          knownKeys.forEach(destKey => {
            const label = String(known[destKey] || destKey);
            const active = allActive || (effectiveSelectedSet instanceof Set && effectiveSelectedSet.has(destKey));
            html += `<button type="button" class="selected-line-chip ${active ? 'is-active' : ''}" data-line="${this.escapeHtmlAttribute(lineCode)}" data-dest="${this.escapeHtmlAttribute(destKey)}">${this.escapeHtmlAttribute(label)}</button>`;
          });
          html += `<button type="button" class="selected-line-chip ${allActive ? 'is-active' : ''}" data-line="${this.escapeHtmlAttribute(lineCode)}" data-dest="__ALL__">Tutte</button>`;
          html += `</div>`;
        }

        html += `</div>`;
      });

      html += `</div>`;
      html += `<hr class="legend-grid-separator">`;

      if (nextRerenderInMs !== null) {
        this.state.uiTimers.directionsStatusTimeout = setTimeout(() => {
          if (this.isLegendVisible()) this.renderLegend();
        }, Math.max(0, Math.ceil(nextRerenderInMs + 25)));
      }
    }

    html += `<div class="legend-header-row">
              <div class="legend-section-title legend-chip">LINEE</div>
              <button id="legend-view-toggle" class="legend-view-toggle legend-chip" type="button" aria-label="${iconLabel}" title="${iconLabel}">${iconSvg}</button>
            </div>`;

    // Lines
    html += `<div class="legend-lines legend-lines--${viewMode}">`;
    let separatorAdded = false;
    const orderedLines = Array.isArray(linesConfig) ? [...linesConfig] : [];
    const idx17 = orderedLines.findIndex(l => l && l.code === '17');
    const idx17s = orderedLines.findIndex(l => l && l.code === '17/');
    if (idx17 !== -1 && idx17s !== -1 && idx17 > idx17s) {
      const tmp = orderedLines[idx17];
      orderedLines[idx17] = orderedLines[idx17s];
      orderedLines[idx17s] = tmp;
    }

    orderedLines.forEach(l => {
      // Add separator before night lines
      if (!separatorAdded && ["A", "B", "C", "D"].includes(l.code)) {
        html += '<hr class="legend-grid-separator">';
        separatorAdded = true;
      }
      
      // Add separator before 777
      if (l.code === "777") {
          html += '<hr class="legend-grid-separator">';
      }

      const isFavorite = this.state.favorites.set.has(l.code);
      if (favoritesOnly && !isFavorite) return;
      if (filterText) {
        const hay = `${l.code} ${l.label} ${(Array.isArray(l.directions) ? l.directions.join(' ') : '')}`.toLowerCase();
        if (!hay.includes(filterText)) return;
      }

      const safeKey = this.escapeHtmlAttribute(l.code);
      const activeClass = this.state.lineVisibility[l.code] ? 'active-line' : '';
      const favSymbol = isFavorite ? '★' : '☆';
      const favClass = isFavorite ? 'is-favorite' : '';
      const title = this.escapeHtmlAttribute(l.label || l.code);
      const pressed = this.state.lineVisibility[l.code] ? 'true' : 'false';
      const tileColor = this.getLegendLineColor(l.code);
      html += `<div class="legend-line-tile ${activeClass}" style="--line-color:${tileColor};" title="${title}">
                <button type="button" class="legend-line-select" data-key="${safeKey}" aria-pressed="${pressed}">
                  <span class="legend-line-code">${this.escapeHtmlAttribute(l.code)}</span>
                  ${viewMode === 'grid' ? `<span class="legend-line-meta">${this.escapeHtmlAttribute(Array.isArray(l.directions) && l.directions.length ? l.directions.join(' • ') : (l.label || l.code))}</span>` : ''}
                </button>
                <button type="button" class="fav-btn legend-line-fav ${favClass}" data-fav="${safeKey}" aria-label="Preferito ${title}">${favSymbol}</button>
              </div>`;
    });
    html += `</div>`;
  
    // "Select All"
    const allSelected = Object.keys(this.state.lineVisibility).every(k => this.state.lineVisibility[k]);

    html += `<button id="select-all-lines-btn" class="legend-action-btn legend-action-toggle ${allSelected ? 'is-active' : ''}" type="button" aria-pressed="${allSelected ? 'true' : 'false'}">SELEZIONA TUTTO</button>`;

    this.legendDiv.innerHTML = html;
    this.legendDiv.scrollTop = prevScrollTop;
    if (wasSearchFocused) {
      const next = document.getElementById('legend-search');
      if (next) {
        next.focus();
        if (typeof searchSelStart === 'number' && typeof searchSelEnd === 'number') next.setSelectionRange(searchSelStart, searchSelEnd);
      }
    }
    
    // Add Listeners
    this.setupLegendListeners();
  }

  preserveLegendScroll(anchorEl, action) {
    if (!this.legendDiv || !anchorEl || typeof action !== 'function') {
      if (typeof action === 'function') action();
      return;
    }
    const container = this.legendDiv;
    const containerRect = container.getBoundingClientRect();
    const beforeTop = anchorEl.getBoundingClientRect().top - containerRect.top;
    action();
    const afterRect = container.getBoundingClientRect();
    const afterTop = anchorEl.getBoundingClientRect().top - afterRect.top;
    const delta = afterTop - beforeTop;
    if (Number.isFinite(delta) && delta !== 0) container.scrollTop += delta;
  }

  preserveLegendScrollByLineKey(lineKey, action) {
    if (!this.legendDiv || !lineKey || typeof action !== 'function') {
      if (typeof action === 'function') action();
      return;
    }
    const container = this.legendDiv;
    const selectorKey = (window.CSS && typeof window.CSS.escape === 'function') ? window.CSS.escape(String(lineKey)) : String(lineKey).replace(/"/g, '\\"');
    const anchorBefore = container.querySelector(`button.legend-line-select[data-key="${selectorKey}"]`);
    if (!anchorBefore) {
      action();
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const beforeTop = anchorBefore.getBoundingClientRect().top - containerRect.top;
    action();
    const anchorAfter = container.querySelector(`button.legend-line-select[data-key="${selectorKey}"]`);
    if (!anchorAfter) return;
    const afterRect = container.getBoundingClientRect();
    const afterTop = anchorAfter.getBoundingClientRect().top - afterRect.top;
    const delta = afterTop - beforeTop;
    if (Number.isFinite(delta) && delta !== 0) container.scrollTop += delta;
  }

  setupLegendListeners() {
    const legendSearch = document.getElementById('legend-search');
    if (legendSearch) {
      legendSearch.addEventListener('input', (e) => {
        const el = e.target;
        const value = el.value || '';
        const start = el.selectionStart;
        const end = el.selectionEnd;
        this.state.legend.filterText = value;
        this.renderLegend();
        const next = document.getElementById('legend-search');
        if (next) {
          next.focus();
          if (typeof start === 'number' && typeof end === 'number') next.setSelectionRange(start, end);
        }
      });
    }

    const viewToggle = document.getElementById('legend-view-toggle');
    if (viewToggle) {
      viewToggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.state.legend.viewMode = this.state.legend.viewMode === 'list' ? 'grid' : 'list';
        this.saveLegendView();
        this.renderLegend();
      });
    }

    const favoritesOnlyBtn = document.getElementById('favorites-only-btn');
    if (favoritesOnlyBtn) {
      const enabledNow = this.legendDiv.dataset.favoritesOnly === '1';
      favoritesOnlyBtn.classList.toggle('is-active', enabledNow);
      favoritesOnlyBtn.setAttribute('aria-pressed', enabledNow ? 'true' : 'false');

      favoritesOnlyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.state.legend.groupKeys instanceof Set) this.state.legend.groupKeys.clear();
        this.recomputeGroupDefaultFilters();
        this.saveLegendGroupKeys();

        const enabled = this.legendDiv.dataset.favoritesOnly !== '1';
        this.legendDiv.dataset.favoritesOnly = enabled ? '1' : '0';

        if (enabled) {
          this.state.favorites.snapshot = { ...this.state.lineVisibility };
          Object.keys(this.state.lineVisibility).forEach(k => {
            this.state.lineVisibility[k] = this.state.favorites.set.has(k);
          });
          this.updateBusMarkers(this.state.lastEnrichedBuses);
          this.updateTrackStyles();
          this.saveActiveLines();
        } else {
          if (this.state.favorites.snapshot) {
            this.state.lineVisibility = { ...this.state.favorites.snapshot };
            this.state.favorites.snapshot = null;
            this.updateBusMarkers(this.state.lastEnrichedBuses);
            this.updateTrackStyles();
            this.saveActiveLines();
          }
        }

        this.renderLegend();
      });
    }

    const favButtons = this.legendDiv.querySelectorAll('button.fav-btn[data-fav]');
    favButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const k = btn.getAttribute('data-fav');
        if (k) this.toggleFavorite(k);
      });
    });

    // Clear All Button
    const clearAllBtn = document.getElementById('clear-all-lines');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.state.legend.groupKeys instanceof Set) this.state.legend.groupKeys.clear();
            this.recomputeGroupDefaultFilters();
            this.saveLegendGroupKeys();
            Object.keys(this.state.lineVisibility).forEach(k => { this.state.lineVisibility[k] = false; });
            this.updateBusMarkers(this.state.lastEnrichedBuses);
            this.updateTrackStyles();
            this.saveActiveLines();
            this.renderLegend();
            this.scheduleNextRefresh(0);
        });
    }

    // Select All
    const selectAllBtn = document.getElementById('select-all-lines-btn');
    if (selectAllBtn) {
      const allSelectedNow = Object.keys(this.state.lineVisibility).every(k => this.state.lineVisibility[k] === true);
      selectAllBtn.classList.toggle('is-active', allSelectedNow);
      selectAllBtn.setAttribute('aria-pressed', allSelectedNow ? 'true' : 'false');

      selectAllBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const allSelectedNext = !Object.keys(this.state.lineVisibility).every(k => this.state.lineVisibility[k] === true);
        const lineButtons = this.legendDiv.querySelectorAll('button.legend-line-select[data-key]');

        const now = Date.now();
        lineButtons.forEach(btn => {
          const k = btn.getAttribute('data-key');
          if (!k) return;
          this.state.lineVisibility[k] = allSelectedNext;
          if (allSelectedNext) {
            if (!this.state.directions.waitStartedAtByLine[k]) this.state.directions.waitStartedAtByLine[k] = now;
          } else {
            delete this.state.directions.waitStartedAtByLine[k];
            delete this.state.directions.filterByLine[k];
          }
          btn.setAttribute('aria-pressed', allSelectedNext ? 'true' : 'false');
          const tile = btn.closest('.legend-line-tile');
          if (tile) tile.classList.toggle('active-line', allSelectedNext);
        });
        if (!allSelectedNext) this.state.directions.expandedLineCode = null;

        selectAllBtn.classList.toggle('is-active', allSelectedNext);
        selectAllBtn.setAttribute('aria-pressed', allSelectedNext ? 'true' : 'false');

        this.updateBusMarkers(this.state.lastEnrichedBuses);
        this.updateTrackStyles();
        this.saveActiveLines();
        this.renderLegend();
        this.scheduleNextRefresh(0);
      });
    }

    const lineButtons = this.legendDiv.querySelectorAll('button.legend-line-select[data-key]');
    lineButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const k = btn.getAttribute('data-key');
        if (!k) return;

        this.preserveLegendScrollByLineKey(k, () => {
          const next = !this.state.lineVisibility[k];
          this.state.lineVisibility[k] = next;
          btn.setAttribute('aria-pressed', next ? 'true' : 'false');

          const tile = btn.closest('.legend-line-tile');
          if (tile) tile.classList.toggle('active-line', next);

          if (next) {
            if (!this.state.directions.waitStartedAtByLine[k]) this.state.directions.waitStartedAtByLine[k] = Date.now();
          } else {
            delete this.state.directions.waitStartedAtByLine[k];
            delete this.state.directions.filterByLine[k];
            if (this.state.directions.overrideModeByLine) delete this.state.directions.overrideModeByLine[k];
            if (this.state.directions.expandedLineCode === k) this.state.directions.expandedLineCode = null;
          }

          if (selectAllBtn) {
            const allSelectedNow = Object.keys(this.state.lineVisibility).every(key => this.state.lineVisibility[key] === true);
            selectAllBtn.classList.toggle('is-active', allSelectedNow);
            selectAllBtn.setAttribute('aria-pressed', allSelectedNow ? 'true' : 'false');
          }

          this.updateBusMarkers(this.state.lastEnrichedBuses);
          this.updateTrackStyles();
          this.saveActiveLines();
          this.renderLegend();
          this.scheduleNextRefresh(0);
        });
      });
    });

    const groupUniBtn = document.getElementById('legend-group-uni');
    if (groupUniBtn) {
      groupUniBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleLegendGroupKey('UNI');
        this.updateBusMarkers(this.state.lastEnrichedBuses);
        this.updateTrackStyles();
        this.saveActiveLines();
        this.renderLegend();
        this.scheduleNextRefresh(0);
      });
    }

    const groupFsBtn = document.getElementById('legend-group-fs');
    if (groupFsBtn) {
      groupFsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleLegendGroupKey('FS');
        this.updateBusMarkers(this.state.lastEnrichedBuses);
        this.updateTrackStyles();
        this.saveActiveLines();
        this.renderLegend();
        this.scheduleNextRefresh(0);
      });
    }

    const selectedLineToggles = this.legendDiv.querySelectorAll('button.selected-line-toggle[data-line]');
    selectedLineToggles.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const lineCode = btn.getAttribute('data-line');
        if (!lineCode) return;
        const expanded = this.state.directions ? this.state.directions.expandedLineCode : null;
        this.state.directions.expandedLineCode = expanded === lineCode ? null : lineCode;
        this.renderLegend();
      });
    });

    const selectedLineChips = this.legendDiv.querySelectorAll('button.selected-line-chip[data-line][data-dest]');
    selectedLineChips.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const lineCode = btn.getAttribute('data-line');
        const dest = btn.getAttribute('data-dest');
        if (!lineCode || !dest) return;
        if (dest === '__ALL__') this.clearDirectionFilter(lineCode);
        else this.toggleDirectionFilter(lineCode, dest);
        this.updateBusMarkers(this.state.lastEnrichedBuses);
        this.updateTrackStyles();
        this.renderLegend();
      });
    });
  }

  getRefreshIntervalMs() {
    const isFollowingSelected = !!(this.state.selectedVehicleKey && !this.state.selectedVehicleKey.startsWith('TRACK_') && this.state.isFollowing);
    if (isFollowingSelected) return CONFIG.REFRESH.FOLLOWING_MS;

    const activeLineCount = Object.keys(this.state.lineVisibility).filter(k => this.state.lineVisibility[k] === true).length;

    if (!this.state.selectedVehicleKey || activeLineCount > CONFIG.REFRESH.MANY_LINES_THRESHOLD) return CONFIG.REFRESH.MANY_LINES_MS;
    return CONFIG.REFRESH.NORMAL_MS;
  }

  scheduleNextRefresh(delayMs) {
    if (this.state.uiTimers.refreshTimeout) {
      clearTimeout(this.state.uiTimers.refreshTimeout);
      this.state.uiTimers.refreshTimeout = null;
    }

    const ms = typeof delayMs === 'number' ? delayMs : this.getRefreshIntervalMs();
    this.state.uiTimers.refreshTimeout = setTimeout(() => {
      this.refreshData();
    }, ms);
  }

  async refreshData() {
    if (this.state.refreshControl.inFlight) {
      this.scheduleNextRefresh(this.getRefreshIntervalMs());
      return;
    }

    const requestId = ++this.state.refreshControl.requestSeq;
    this.state.refreshControl.inFlight = true;

    try {
        const activeLineCount = Object.keys(this.state.lineVisibility).filter(k => this.state.lineVisibility[k] === true).length;
        
        // Optimization Logic
        // <= 5 directions: All stops
        // > 5 directions: Terminals + 1 intermediate (approx 3 stops total per line)
        // > 10 directions: Terminals only (approx 2 stops total per line)
        
        let stopsLimitPerLine = Infinity;
        if (activeLineCount > CONFIG.REFRESH.MANY_LINES_THRESHOLD) {
            stopsLimitPerLine = 2; // Usually just terminals
        } else if (activeLineCount > 5) {
            stopsLimitPerLine = 3; // Terminals + 1 intermediate
        }

        const uniqueStops = new Set();
        let hasActiveLines = false;

        linesConfig.forEach(l => {
            const isLineActive = this.state.lineVisibility[l.code] === true;

            if (isLineActive) {
                hasActiveLines = true;
                
                // Select stops based on limit
                // IMPORTANT: l.stops is ordered. Usually terminals are first? 
                // We should ensure we pick meaningful stops if we limit them.
                // Assuming linesConfig has relevant stops first or we just take the first N.
                // The user said "Terminals + 1 intermediate". 
                // In lines.js, stops are just a list. We assume the first 2 are often terminals or main stops.
                
                let stopsToUse;
                if (stopsLimitPerLine === Infinity) {
                    stopsToUse = l.stops;
                } else {
                    const src = Array.isArray(l.stops) ? l.stops : [];
                    if (src.length <= stopsLimitPerLine) {
                        stopsToUse = src;
                    } else if (stopsLimitPerLine <= 1) {
                        stopsToUse = [src[0]];
                    } else {
                        const picked = [];
                        const lastIdx = src.length - 1;
                        for (let i = 0; i < stopsLimitPerLine; i++) {
                            const idx = Math.round((i * lastIdx) / (stopsLimitPerLine - 1));
                            picked.push(src[idx]);
                        }
                        stopsToUse = picked;
                    }
                }
                
                stopsToUse.forEach(s => uniqueStops.add(s));
            }
        });

        // If no lines are active, clear markers
        if (!hasActiveLines) {
            this.updateBusMarkers([]); 
            this.updateTrackStyles();
            return;
        }

        if (requestId !== this.state.refreshControl.requestSeq) return;

        const stopsList = Array.from(uniqueStops);

        // 2. Fetch data (Async/Await)
        const requests = stopsList.map(code => this.fetchStopRuns(code));
        const results = await Promise.all(requests);

        if (requestId !== this.state.refreshControl.requestSeq) return;

        // Map results
        const stopDataMap = {};
        stopsList.forEach((code, idx) => {
            stopDataMap[code] = Array.isArray(results[idx]) ? results[idx] : [];
        });

        // 3. Process Vehicles
        const buses = [];
        linesConfig.forEach(lineConf => {
            const paletteColor = this.getLegendLineColor(lineConf.code);
            Object.keys(stopDataMap).forEach(sCode => {
                const runs = stopDataMap[sCode];
                runs.forEach(r => {
                    const code = (r.LineCode || "").toUpperCase();
                    if (code === lineConf.code) {
                        const lat = r.Latitude || 0;
                        const lon = r.Longitude || 0;
                        if (lat !== 0 && lon !== 0) {
                            buses.push({
                                coords: [lat, lon],
                                vehicle: r.Vehicle || "",
                                race: String(r.Race || ""),
                                direction: r.Direction || "",
                                destination: r.Destination || "",
                                departure: r.Departure || "",
                                nextPasses: r.NextPasses || "",
                                lineLabel: lineConf.label,
                                lineColor: paletteColor,
                                lineCode: lineConf.code
                            });
                        }
                    }
                });
            });
        });

        // 4. Deduplicate and Enrich
        const byVehicle = {};
        buses.forEach(b => {
            const k = b.vehicle || `NO_VEHICLE_${b.coords[0]}_${b.coords[1]}`;
            byVehicle[k] = b;
        });

        const uniqueBuses = Object.values(byVehicle);

        const enriched = uniqueBuses.map(b => {
            const key = b.key || b.vehicle || `NO_VEHICLE_${b.coords[0]}_${b.coords[1]}`;
            const prev = this.state.vehicleState[key];
            let heading = (prev && typeof prev.heading === 'number') ? prev.heading : 0;
            const moved = !prev || prev.lat !== b.coords[0] || prev.lon !== b.coords[1];
            
            if (prev && moved) {
                heading = this.computeBearing(prev.lat, prev.lon, b.coords[0], b.coords[1]);
            }
            
            this.state.vehicleState[key] = { 
              lat: b.coords[0], 
              lon: b.coords[1], 
              heading: heading, 
              moved: moved,
              lastEnrichedBus: b 
            };
            b.heading = heading;
            b.key = key;
            b.moved = moved;
            return b;
        });

        this.updateKnownDirectionsFromStopData(stopDataMap);

        // 5. Process Tracks
        this.processTracks(stopDataMap);

        let selected = null;
        let selectedPrevLatLng = null;
        if (this.state.selectedVehicleKey && !this.state.selectedVehicleKey.startsWith('TRACK_')) {
          const m = this.state.busMarkers[this.state.selectedVehicleKey];
          if (m) selectedPrevLatLng = m.getLatLng();
        }

        this.updateBusMarkers(enriched);

        // Update selected info
        if (this.state.selectedVehicleKey) {
            selected = enriched.find(b => b.key === this.state.selectedVehicleKey);
        }
        this.state.updateStatus.lastSuccessAt = Date.now();
        this.state.updateStatus.lastErrorMessage = '';

        if (selected && selected.key && this.state.selectedVehicleKey === selected.key && selectedPrevLatLng) {
          const moved = selectedPrevLatLng.lat !== selected.coords[0] || selectedPrevLatLng.lng !== selected.coords[1];
          if (moved) this.state.updateStatus.lastSelectedMoveAt = Date.now();
        }

        this.updateInfoFromBus(selected);

    } catch (err) {
        this.state.updateStatus.lastErrorAt = Date.now();
        this.state.updateStatus.lastErrorMessage = (err && err.message) ? String(err.message) : 'Errore di connessione';
        console.error("Errore aggiornamento dati", err);
        this.showToast("Errore di connessione. Riprovo...", "error");
        this.updateInfoFromBus(this.state.selectedVehicleKey ? { key: this.state.selectedVehicleKey } : null);
    } finally {
        if (requestId >= this.state.refreshControl.lastAppliedRequestSeq) {
          this.state.refreshControl.lastAppliedRequestSeq = requestId;
        }
        this.state.refreshControl.inFlight = false;
        this.scheduleNextRefresh(this.getRefreshIntervalMs());
    }
  }

  processTracks(stopDataMap) {
    const visible = new Set();

    linesConfig.forEach(lineConf => {
        if (this.state.lineVisibility[lineConf.code] !== true) return;

        if (lineConf.code === "777") {
            const dir = "CASINÒ VENEZIA";
            this.handleEasterEggTrack(lineConf, dir);
            visible.add("777_CASINÒ VENEZIA");
            return;
        }

        const allRuns = [];
        lineConf.stops.forEach(sCode => {
            const runs = stopDataMap[sCode];
            if (!Array.isArray(runs)) return;
            runs.forEach(r => {
                if ((r.LineCode || "").toUpperCase() === lineConf.code) allRuns.push(r);
            });
        });

        const bestByDest = new Map();
        allRuns.forEach(r => {
            const destRaw = (r.Destination || "").trim();
            const destKey = normalizeKey(destRaw);
            if (!destKey) return;
            const existing = bestByDest.get(destKey);
            if (!existing) {
                bestByDest.set(destKey, r);
                return;
            }
            if (!existing.Race && r.Race) bestByDest.set(destKey, r);
        });

        bestByDest.forEach((bestRun, destKey) => {
            if (!bestRun || !bestRun.Race) return;
            if (!this.isDirectionAllowed(lineConf.code, destKey)) return;

            const race = String(bestRun.Race);
            const destination = (bestRun.Destination || destKey).trim();
            const trackKey = `${lineConf.code}_${destKey}`;
            visible.add(trackKey);

            if (!this.state.trackRefreshCounters[trackKey]) this.state.trackRefreshCounters[trackKey] = 0;
            if (!this.state.lastRaces[trackKey]) this.state.lastRaces[trackKey] = "";

            const prevRace = this.state.lastRaces[trackKey];
            const counter = this.state.trackRefreshCounters[trackKey] || 0;
            const shouldFetch = race && (race !== prevRace || counter >= CONFIG.REFRESH.TRACK_REFRESH_INTERVAL || !this.state.routeLayers[trackKey]);

            if (!shouldFetch) {
                this.state.trackRefreshCounters[trackKey] = counter + 1;
                return;
            }

            this.state.lastRaces[trackKey] = race;
            this.state.trackRefreshCounters[trackKey] = 0;

            let lineCodeForTrack = String(bestRun.Line || '').trim();
            if (!lineCodeForTrack) {
                lineCodeForTrack = String(bestRun.LineCode || '').trim();
                if (lineCodeForTrack && !lineCodeForTrack.startsWith('T')) lineCodeForTrack = `T${lineCodeForTrack}`;
            }
            if (!lineCodeForTrack) return;

            const url = `https://realtime.tplfvg.it/API/v1.0/polemonitor/LineGeoTrack?Line=${encodeURIComponent(lineCodeForTrack)}&Race=${encodeURIComponent(race)}&_=${Date.now()}`;

            fetch(url)
                .then(r => r.json())
                .then(track => {
                    if (Array.isArray(track)) this.updateTrackLayer(trackKey, lineConf, destination, track);
                })
                .catch(err => console.error(`Errore caricamento tracciato ${trackKey}`, err));
        });
    });

    this.state.visibleTrackKeys = visible;
  }

  handleEasterEggTrack(lineConf, dir) {
      const trackKey = "777_CASINÒ VENEZIA";
      const paletteColor = this.getLegendLineColor(lineConf.code);
      
      if (!this.state.routeLayers[trackKey]) {
          const pts = easterEggTrack777;
          const polyline = L.polyline(pts, { 
              color: paletteColor, 
              weight: 3.5, 
              dashArray: '10, 10' 
          }).addTo(this.state.map);
          
          this.state.routeLayers[trackKey] = polyline;
          polyline.options.lineCode = lineConf.code;
          polyline.options.destination = dir;

          polyline.on('click', (e) => {
              L.DomEvent.stopPropagation(e);
              this.state.selectedVehicleKey = "TRACK_" + trackKey;
              this.updateInfoFromTrack(lineConf, dir);
              if (this.legendDiv.style.display === 'block') {
                  this.legendDiv.style.display = 'none';
              }
              this.updateBusMarkers(this.state.lastEnrichedBuses);
          });

          // Endpoints
          const endpoints = [];
          if (pts.length > 0) {
              const startIcon = L.divIcon({ className: 'endpoint-icon start', html: '', iconSize: [12, 12] });
              const endIcon = L.divIcon({ className: 'endpoint-icon end', html: '', iconSize: [12, 12] });
              endpoints.push(L.marker(pts[0], { icon: startIcon }).addTo(this.state.map));
              endpoints.push(L.marker(pts[pts.length - 1], { icon: endIcon }).addTo(this.state.map));
              this.state.routeEndpointMarkers[trackKey] = endpoints;
          }
          
          // Initial styles
          this.updateTrackStyles();
      }
  }

  updateTrackLayer(trackKey, lineConf, destination, trackData) {
      const paletteColor = this.getLegendLineColor(lineConf.code);
      const pts = [];
      trackData.forEach(segment => {
          if (Array.isArray(segment)) {
              segment.forEach(pair => {
                  if (Array.isArray(pair) && pair.length === 2) {
                      pts.push([pair[1], pair[0]]);
                  }
              });
          }
      });

      // Update existing or create new
      if (this.state.routeLayers[trackKey]) {
          // Just update geometry, do not remove/add (prevents flicker and layout thrashing)
          this.state.routeLayers[trackKey].setLatLngs(pts);
          this.state.routeLayers[trackKey].options.destination = destination;
      } else {
          const polyline = L.polyline(pts, { color: paletteColor, weight: 3.5 }).addTo(this.state.map);
          this.state.routeLayers[trackKey] = polyline;
          polyline.options.lineCode = lineConf.code;
          polyline.options.destination = destination;

          polyline.on('click', (e) => {
              L.DomEvent.stopPropagation(e);
              this.state.selectedVehicleKey = "TRACK_" + trackKey;
              this.updateInfoFromTrack(lineConf, destination);
              if (this.legendDiv.style.display === 'block') {
                  this.legendDiv.style.display = 'none';
              }
              this.updateBusMarkers(this.state.lastEnrichedBuses);
          });
      }

      // Endpoints (always recreate or update - here we recreate for simplicity as they are few)
      if (this.state.routeEndpointMarkers[trackKey]) {
          this.state.routeEndpointMarkers[trackKey].forEach(m => this.state.map.removeLayer(m));
      }

      const endpoints = [];
      if (pts.length > 0) {
          const start = pts[0];
          const end = pts[pts.length - 1];
          endpoints.push(L.circleMarker(start, { radius: 3.5, color: paletteColor, fillColor: paletteColor, fillOpacity: 1 }).addTo(this.state.map));
          endpoints.push(L.circleMarker(end, { radius: 3.5, color: paletteColor, fillColor: paletteColor, fillOpacity: 1 }).addTo(this.state.map));
      }
      this.state.routeEndpointMarkers[trackKey] = endpoints;
      
      this.updateTrackStyles();
  }

  updateBusMarkers(buses) {
    this.state.lastEnrichedBuses = buses || [];
    const newKeys = new Set();
    
    const zoom = this.state.map ? this.state.map.getZoom() : CONFIG.MAP.DEFAULT_ZOOM;
    const zoomScale = this.getBusIconZoomScale(zoom);
    const showLabel = this.shouldShowBusLabel(zoom);

    const activeLineCount = Object.keys(this.state.lineVisibility).filter(k => this.state.lineVisibility[k] === true).length;
    const useSmallIcons = activeLineCount >= CONFIG.UI.SMALL_ICON_THRESHOLD;
    const iconSize = useSmallIcons ? [28, 28] : [40, 40];
    const iconAnchor = useSmallIcons ? [14, 14] : [20, 20];
    const sizeClass = useSmallIcons ? 'small' : 'large';

    if (buses && buses.length > 0) {
      buses.forEach(b => {
        if (this.state.lineVisibility[b.lineCode] !== true) return;
        if (!this.isDirectionAllowed(b.lineCode, b.destination)) return;

        newKeys.add(b.key);

        const paletteColor = this.getLegendLineColor(b.lineCode);
        const labelTextColor = this.state.theme.mode === 'light' ? '#111' : '#fff';
        
        let isSelected = false;
        if (this.state.selectedVehicleKey) {
            if (this.state.selectedVehicleKey.startsWith("TRACK_")) {
                const trackKey = this.state.selectedVehicleKey.substring(6);
                const busTrackKey = `${b.lineCode}_${normalizeKey(b.destination)}`;
                if (trackKey === busTrackKey) isSelected = true;
            } else if (b.key === this.state.selectedVehicleKey) {
                isSelected = true;
            }
        }

        const opacity = (this.state.selectedVehicleKey && !isSelected) ? 0.3 : 1.0;
        const heading = typeof b.heading === 'number' ? b.heading : 0;
        const selectionBorderColor = this.state.theme.mode === 'light' ? '#111' : '#FFF';
        const borderStyle = isSelected ? `border: 3px solid ${selectionBorderColor};` : '';
        const opacityStyle = `opacity: ${opacity};`;
        const labelText = showLabel ? b.lineLabel : '';
        const iconHtml = `<div class="bus-icon ${sizeClass}" style="background-color: ${paletteColor}; transform: rotate(${heading + 135}deg) scale(${zoomScale}); ${borderStyle} ${opacityStyle}"><span style="display:inline-block; transform: rotate(${-(heading + 135)}deg); color: ${labelTextColor}; opacity: ${showLabel ? 1 : 0};">${labelText}</span></div>`;

        let marker;
        if (this.state.busMarkers[b.key]) {
            // Update existing
            marker = this.state.busMarkers[b.key];
            const prev = marker.getLatLng();
            const samePos = prev && prev.lat === b.coords[0] && prev.lng === b.coords[1];
            if (!samePos) marker.setLatLng(b.coords);
            marker.setZIndexOffset(isSelected ? 1000 : 0);
            
            // Optimization: Update DOM directly to preserve smooth transition
            const currentIcon = marker.options.icon;
            const isSameSize = currentIcon && currentIcon.options && currentIcon.options.className && currentIcon.options.className.includes(sizeClass);
            let updated = false;

            if (isSameSize) {
                const el = marker.getElement();
                if (el) {
                    const iconDiv = el.querySelector('.bus-icon');
                    if (iconDiv) {
                        // Update styles directly
                        iconDiv.style.backgroundColor = paletteColor;
                        iconDiv.style.transform = `rotate(${heading + 135}deg) scale(${zoomScale})`;
                        iconDiv.style.opacity = opacity;
                        iconDiv.style.border = isSelected ? `3px solid ${selectionBorderColor}` : '';
                        
                        // Update text content (only if changed)
                        const span = iconDiv.querySelector('span');
                        if (span) {
                            if (span.textContent !== labelText) span.textContent = labelText;
                            span.style.transform = `rotate(${-(heading + 135)}deg)`;
                            span.style.color = labelTextColor;
                            span.style.opacity = showLabel ? '1' : '0';
                        }
                        updated = true;
                    }
                }
            }
            
            if (!updated) {
                 const newIcon = L.divIcon({
                    className: `bus-icon-wrapper ${sizeClass}`,
                    html: iconHtml,
                    iconSize: iconSize,
                    iconAnchor: iconAnchor
                });
                marker.setIcon(newIcon);
            }
        } else {
            // Create new
             const icon = L.divIcon({
                className: `bus-icon-wrapper ${sizeClass}`,
                html: iconHtml,
                iconSize: iconSize,
                iconAnchor: iconAnchor
              });

             marker = L.marker(b.coords, { icon: icon, zIndexOffset: isSelected ? 1000 : 0 }).addTo(this.state.map);
             this.state.busMarkers[b.key] = marker;
        }

        // Update click handler (for both new and existing to ensure fresh closure and isFollowing logic)
        marker.off('click');
        marker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.state.selectedVehicleKey = b.key || (b.vehicle || (`NO_VEHICLE_${b.coords[0]}_${b.coords[1]}`));
            this.state.isFollowing = true;
            this.updateInfoFromBus(b);
            if (this.legendDiv.style.display === 'block') {
                this.legendDiv.style.display = 'none';
            }
            this.updateBusMarkers(this.state.lastEnrichedBuses);
        });

        // Follow logic
        if (isSelected && this.state.isFollowing && !this.state.selectedVehicleKey.startsWith("TRACK_")) {
            this.state.map.panTo(b.coords);
        }
      });
    }

    // Remove old markers
    Object.keys(this.state.busMarkers).forEach(key => {
        if (!newKeys.has(key)) {
            this.state.map.removeLayer(this.state.busMarkers[key]);
            delete this.state.busMarkers[key];
        }
    });

    this.updateTrackStyles();
  }

  updateTrackStyles() {
    let targetTrackKey = null;
    if (this.state.selectedVehicleKey) {
        if (this.state.selectedVehicleKey.startsWith("TRACK_")) {
            targetTrackKey = this.state.selectedVehicleKey.substring(6);
        } else {
            if (this.state.lastEnrichedBuses) {
                const selectedBus = this.state.lastEnrichedBuses.find(b => b.key === this.state.selectedVehicleKey);
                if (selectedBus) {
                    targetTrackKey = `${selectedBus.lineCode}_${normalizeKey(selectedBus.destination)}`;
                }
            }
        }
    }

    Object.keys(this.state.routeLayers).forEach(tKey => {
        const layer = this.state.routeLayers[tKey];
        const endpoints = this.state.routeEndpointMarkers[tKey];
        if (!layer) return;

        const lineCode = layer.options.lineCode;
        const paletteColor = this.getLegendLineColor(lineCode);
        const isVisibleByLine = this.state.lineVisibility[lineCode] === true;
        const isVisibleByData = this.state.visibleTrackKeys instanceof Set ? this.state.visibleTrackKeys.has(tKey) : true;
        const idxDir = tKey.indexOf('_');
        const destKeyForDir = idxDir !== -1 ? tKey.slice(idxDir + 1) : '';
        const isVisibleByDirection = this.isDirectionAllowed(lineCode, destKeyForDir);

        const isVisible = isVisibleByLine && isVisibleByData && isVisibleByDirection;

        if (!isVisible) {
            layer.setStyle({ opacity: 0, weight: 0 });
            if (endpoints) {
                endpoints.forEach(e => {
                    if (e.setStyle) e.setStyle({ opacity: 0, fillOpacity: 0 });
                    else if (e.setOpacity) e.setOpacity(0);
                });
            }
            return;
        }

        // Visible
        let opacity = 1.0;
        if (this.state.selectedVehicleKey) {
            if (tKey !== targetTrackKey) {
                opacity = 0.35;
            } else {
                layer.bringToFront();
            }
        }

        layer.setStyle({ color: paletteColor, opacity: opacity, weight: 3 });
        if (endpoints) {
            endpoints.forEach(e => {
                if (e.setStyle) e.setStyle({ color: paletteColor, fillColor: paletteColor, opacity: opacity, fillOpacity: opacity });
                else if (e.setOpacity) e.setOpacity(opacity);
            });
        }
    });

    this.updateEasterEggAnimation();
  }

  updateEasterEggAnimation() {
    const isVisible = this.state.lineVisibility["777"] === true;

    if (isVisible) {
        // Start if not active
        if (!this.state.easterEgg.active) {
            this.state.easterEgg.active = true;
            this.state.easterEgg.index = 0;
            
            // Create marker
            const startCoords = easterEggTrack777[0];
            const icon = L.icon({
                iconUrl: 'icona_bateo_gambling.webp',
                iconSize: [40, 40],
                iconAnchor: [20, 20]
            });

            this.state.easterEgg.marker = L.marker(startCoords, { 
                icon: icon, 
                zIndexOffset: 2000 
            }).addTo(this.state.map);
            
            // Bind popup if desired
            this.state.easterEgg.marker.bindPopup("🎰 777 Bateo Gambling 🎰<br>Verso il Casinò!");

            // Start Animation Loop
            this.state.easterEgg.interval = setInterval(() => {
                const nextIndex = this.state.easterEgg.index + 1;
                if (nextIndex < easterEggTrack777.length) {
                    this.state.easterEgg.index = nextIndex;
                    const newCoords = easterEggTrack777[nextIndex];
                    // Use setLatLng for smooth transition if CSS is applied to .leaflet-marker-icon
                    this.state.easterEgg.marker.setLatLng(newCoords);
                } else {
                    // Reached destination
                    clearInterval(this.state.easterEgg.interval);
                    this.state.easterEgg.interval = null;
                }
            }, 2000);
        }
    } else {
        // Stop and Cleanup if active
        if (this.state.easterEgg.active) {
            this.state.easterEgg.active = false;
            if (this.state.easterEgg.interval) {
                clearInterval(this.state.easterEgg.interval);
                this.state.easterEgg.interval = null;
            }
            if (this.state.easterEgg.marker) {
                this.state.map.removeLayer(this.state.easterEgg.marker);
                this.state.easterEgg.marker = null;
            }
            this.state.easterEgg.index = 0;
        }
    }
  }

  updateInfoFromBus(bus) {
    if (!bus) {
      if (this.state.lastInfoSignature !== null) {
        // If we had a selected vehicle and now it's gone, it might have finished its trip
        if (this.state.selectedVehicleKey && !this.state.selectedVehicleKey.startsWith('TRACK_')) {
          this.infoDiv.innerHTML = `
            <div class="info-header" style="border-bottom-color: rgba(220, 53, 69, 0.3)">
              <div class="info-line-badge" style="background-color: #666">⚠</div>
              <div class="info-destination" style="color: #ff6b6b">Corsa terminata</div>
            </div>
            <div class="info-body">
              <div style="grid-column: 1 / -1; color: #aaa; font-size: 12px; margin-top: 4px;">
                Il veicolo non è più rilevato dal sistema. È probabile che abbia raggiunto il capolinea.
              </div>
            </div>
          `;
          this.infoDiv.style.display = 'block';
          // We keep the selected key so the message stays until user deselects or selects another
          this.state.lastInfoSignature = "FINISHED_TRIP"; 
          return;
        }
        
        this.infoDiv.style.display = 'none';
        this.infoDiv.innerHTML = "";
        this.state.lastInfoSignature = null;
      }
      return;
    }

    const now = Date.now();
    const lastSuccessAt = this.state.updateStatus.lastSuccessAt || 0;
    const lastErrorAt = this.state.updateStatus.lastErrorAt || 0;
    const lastSelectedMoveAt = this.state.updateStatus.lastSelectedMoveAt || 0;
    const isOffline = lastErrorAt > lastSuccessAt;
    const ageSec = lastSelectedMoveAt ? Math.max(0, Math.floor((now - lastSelectedMoveAt) / 1000)) : null;
    const statusText = isOffline ? 'offline/errore' : 'ok';

    const signature = `${bus.key}|${bus.lineLabel}|${bus.destination}|${bus.departure}|${bus.race}|${bus.vehicle}|${statusText}|${ageSec}`;
    if (signature === this.state.lastInfoSignature) return;
    this.state.lastInfoSignature = signature;

    const baseTs = lastSelectedMoveAt || lastSuccessAt;
    let timeStr = "--:--:--";
    if (baseTs) {
      const dt = new Date(baseTs);
      timeStr = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}`;
    }

    const badgeClass = isOffline ? "offline" : "online";
    const ageText = isOffline ? "offline" : `${(lastSelectedMoveAt ? Math.max(0, Math.floor((now - lastSelectedMoveAt) / 1000)) : Math.max(0, Math.floor((now - lastSuccessAt) / 1000)))}s fa`;

    this.infoDiv.innerHTML = `
      <div class="info-header">
        <div class="info-line-badge" style="background-color: ${bus.lineCode ? this.getLegendLineColor(bus.lineCode) : bus.lineColor}">${bus.lineLabel}</div>
        <div class="info-destination">${bus.destination}</div>
      </div>
      <div class="info-body">
        <div class="info-label">Partenza</div><div class="info-value">${bus.departure || '-'}</div>
        <div class="info-label">Corsa</div><div class="info-value">${bus.race || '-'}</div>
        <div class="info-label">Vettura</div><div class="info-value">${bus.vehicle || '-'}</div>
      </div>
      <div class="info-footer">
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
          <span id="info-update-badge" class="${badgeClass}" style="padding: 2px 8px; border-radius: 10px; background: ${isOffline ? 'rgba(180,60,60,0.2)' : 'rgba(60,180,120,0.15)'}; border: 1px solid ${isOffline ? 'rgba(180,60,60,0.4)' : 'rgba(60,180,120,0.4)'}">
            Aggiornato ${ageText}
          </span>
          <span style="color: #888;">${timeStr}</span>
        </div>
      </div>
    `;
    this.infoDiv.style.display = 'block';
  }

  updateInfoAgeBadge() {
    if (!this.infoDiv || this.infoDiv.style.display === 'none') return;
    const badge = this.infoDiv.querySelector('#info-update-badge');
    const timeSpan = this.infoDiv.querySelector('.info-footer span:last-child');
    if (!badge) return;

    const now = Date.now();
    const lastSuccessAt = this.state.updateStatus.lastSuccessAt || 0;
    const lastErrorAt = this.state.updateStatus.lastErrorAt || 0;
    const lastSelectedMoveAt = this.state.updateStatus.lastSelectedMoveAt || 0;
    const isOffline = lastErrorAt > lastSuccessAt;

    if (isOffline) {
      badge.textContent = 'Aggiornato offline';
      badge.style.background = 'rgba(180, 60, 60, 0.2)';
      badge.style.border = '1px solid rgba(180, 60, 60, 0.4)';
      return;
    }

    const base = lastSelectedMoveAt || lastSuccessAt;
    const ageSec = base ? Math.max(0, Math.floor((now - base) / 1000)) : null;
    badge.textContent = `Aggiornato ${ageSec === null ? '?' : ageSec}s fa`;
    badge.style.background = 'rgba(60, 180, 120, 0.15)';
    badge.style.border = '1px solid rgba(60, 180, 120, 0.4)';

    if (timeSpan && base) {
      const dt = new Date(base);
      timeSpan.textContent = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}`;
    }
  }

  updateInfoFromTrack(lineConf, direction) {
    if (!lineConf) {
        this.infoDiv.style.display = 'none';
        this.infoDiv.innerHTML = "";
        return;
    }
    this.infoDiv.innerHTML = `
      <div class="info-header" style="border-bottom: none; margin-bottom: 0; padding-bottom: 0;">
        <div class="info-line-badge" style="background-color: ${this.getLegendLineColor(lineConf.code)}">${lineConf.label}</div>
        <div class="info-destination">${direction}</div>
      </div>
    `;
    this.infoDiv.style.display = 'block';
  }

  getBusIconZoomScale(zoom) {
    const z = typeof zoom === 'number' ? zoom : CONFIG.MAP.DEFAULT_ZOOM;
    const base = CONFIG.MAP.DEFAULT_ZOOM;
    const max = 19;
    const tRaw = (z - base) / (max - base);
    const t = Math.max(0, Math.min(1, tRaw));
    const eased = 1 - Math.pow(1 - t, 3);
    const minScale = 0.56;
    const maxScale = Math.max(minScale, Number(CONFIG.UI.BUS_ICON_SCALE_MAX) || 1.0);
    return minScale + (maxScale - minScale) * eased;
  }

  shouldShowBusLabel(zoom) {
    const z = typeof zoom === 'number' ? zoom : CONFIG.MAP.DEFAULT_ZOOM;
    return z >= (CONFIG.MAP.DEFAULT_ZOOM + 1);
  }

  computeBearing(lat1, lon1, lat2, lon2) {
    const toRad = x => x * Math.PI / 180;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    return (θ * 180 / Math.PI + 360) % 360;
  }
}

// Initialize
const app = new BusMagoApp();
document.addEventListener('DOMContentLoaded', () => {
    app.init();
});
