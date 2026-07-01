// Initial configuration
const linesConfig = window.linesConfig || [];

// Configuration constants
const CONFIG = {
  REFRESH: {
    // Cadenze di refresh. Più sono basse, più la mappa è "fresca" ma più richieste
    // si fanno all'API: l'API TPL FVG applica un rate-limit per IP e dopo qualche
    // minuto di polling troppo aggressivo BLOCCA il client (le mrcruns iniziano a
    // fallire e le vetture si "congelano" sull'ultima posizione in cache). Questi
    // valori tengono il volume sostenibile anche su sessioni lunghe.
    FOLLOWING_MS: 2500,   // quando segui un bus selezionato: reattivo ma non estremo
    NORMAL_MS: 4000,      // panoramica (caso tipico, sessione lunga): conservativo
    MANY_LINES_MS: 7000,  // molte linee: ancora più diluito
    MANY_LINES_THRESHOLD: 10,
    TRACK_REFRESH_INTERVAL: 50  // tracciati ~statici: rinfresco molto raro
  },
  SAMPLING: {
    // Tetto pratico di fetch/ciclo: il budget viene diviso fra le linee attive,
    // così a più linee corrispondono meno fermate per linea (i capolinea sono
    // comunque sempre interrogati a parte). MAX limita la densità quando le linee
    // sono poche; MIN evita di degradare troppo con molte linee.
    // ⚠️ Il budget è il principale regolatore del COMPROMESSO precisione/rate-limit:
    // fermate/ciclo ÷ periodo = richieste/secondo verso l'API. Con FETCH_BUDGET=80
    // e NORMAL_MS=4000 il volume sostenuto resta ~15 req/s (gestibile su sessioni
    // lunghe). Alzarlo dà copertura spaziale leggermente migliore ma rischia il
    // blocco IP dopo qualche minuto (vetture congelate). Non superare ~100 senza
    // allungare anche gli intervalli in CONFIG.REFRESH.
    FETCH_BUDGET: 80,
    MIN_STOPS_PER_LINE: 8,
    MAX_STOPS_PER_LINE: 40
  },
  CACHE: {
    STOP_RUNS_TTL_MS: 5000
  },
  RATE: {
    // Tetto di richieste/secondo verso l'API realtime (mrcruns). Il rate-limiter
    // (_rateSlot) SPALMA le richieste di ogni ciclo a questa cadenza invece di
    // spararle tutte insieme con Promise.all: elimina il "burst" istantaneo che,
    // soprattutto alla RIAPERTURA dell'app (cache svuotata → ciclo tutto-rete),
    // faceva scattare il rate-limit per-IP del TPL FVG (mrcruns falliscono →
    // vetture congelate). Vincolo: tenerlo ≥ carico di picco offerto
    // (~fermate_per_ciclo ÷ intervallo_minimo) per non accumulare backlog, e ben
    // SOTTO la soglia reale dell'API. Tarare con lo script api-rate-probe.py.
    MAX_RPS: 36
  },
  UI: {
    TOAST_DURATION_MS: 3000,
    SMALL_ICON_THRESHOLD: 10,
    BUS_ICON_SCALE_MAX: 0.92,
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

// directions can be a legacy array of names OR an object keyed by API
// direction. Values may be a single name or a list of terminals per direction
// (e.g. { "A": ["PIAZZA OBERDAN", "PIAZZA TOMMASEO"], "R": ["VILLA CARSIA"] }).
// Normalize to a flat list of destination names.
const directionsList = (d) => {
  if (Array.isArray(d)) return d.flat(Infinity).filter(Boolean);
  if (d && typeof d === 'object') return Object.values(d).flat(Infinity).filter(Boolean);
  return [];
};

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
    '51': []   // array vuoto = mostra tutte le corse della 51 (nessun filtro destinazione)
  },
  FS: {
    '17/': ['STAZIONE FERROVIARIA'],
    '17': ['VIA DI CAMPO MARZIO'],
    '4': ['PIAZZA OBERDAN', 'PIAZZA TOMMASEO'],
    '51': [],   // array vuoto = mostra tutte le corse della 51 (nessun filtro destinazione)
    '3': ['STAZIONE FERROVIARIA']
  },
  BARCOLA: {
    '6': [],
    '19': [],
    '20': [],
    '36': []
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
      trackFetchControllers: {},
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
      skin: {
        key: 'busmago:skin:v1',
        mode: 'classic' // 'classic' (look storico/main, default) | 'modern' (Google 2026 glossy)
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
      departures: {
        collapsed: false,
        storageKey: 'busmago:departuresCollapsed:v1'
      },
      infoPanel: {
        selectedBus: null,
        selectedTrack: null,
        finishedTrip: false,
        selectedInfoLine: null,
        collapsed: false,
        collapsedStorageKey: 'busmago:vehicleCollapsed:v1'
      },
      lastStopDataMap: null,
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
        lastAppliedRequestSeq: 0,
        abortController: null
      },
      isHardRefreshing: false,
      wakeLock: null,
      justResumedFromBackground: false // Flag to force fresh data on first refresh after resume
    };

    // DOM Elements
    this.infoDiv = document.querySelector('.info');
    this.legendDiv = document.getElementById('legend');
    this.toastDiv = null;

    // Bindings
    this.refreshData = this.refreshData.bind(this);
    this.hardRefreshData = this.hardRefreshData.bind(this);
  }

  // Feedback aptico (solo dispositivi che supportano l'API Vibration, di fatto
  // mobile Android/Chrome; iOS Safari la ignora silenziosamente). Avvolto in
  // try/catch perché alcuni browser la espongono ma la bloccano senza gesto utente.
  hapticFeedback(pattern) {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern);
      }
    } catch {}
  }

  // Vocabolario aptico semantico: pochi pattern riconoscibili e coerenti su tutta
  // l'app, così ogni tipo di interazione "si sente" diverso (più intuitivo di una
  // vibrazione unica). Tutti passano da hapticFeedback (no-op dove non supportato).
  //   tap     → tocco leggero per i bottoni-icona dei controlli mappa
  //   toggle  → accensione/spegnimento di una linea o di un preferito
  //   select  → selezione "importante" (es. bus seguito), più netta
  //   success → conferma di un'azione di gruppo (seleziona/azzera tutto, gruppi)
  hapticTap()     { this.hapticFeedback(10); }
  hapticToggle()  { this.hapticFeedback(18); }
  hapticSelect()  { this.hapticFeedback(30); }
  hapticSuccess() { this.hapticFeedback([14, 40, 22]); }

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
      if (key !== 'UNI' && key !== 'FS' && key !== 'BARCOLA') return;
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
      if (key !== 'UNI' && key !== 'FS' && key !== 'BARCOLA') return;
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
    const k = key === 'UNI' || key === 'FS' || key === 'BARCOLA' ? key : null;
    if (!k) return;
    this.hapticSuccess();
    if (!(this.state.legend.groupKeys instanceof Set)) this.state.legend.groupKeys = new Set();
    
    const wasActive = this.state.legend.groupKeys.has(k);
    if (wasActive) {
      this.state.legend.groupKeys.delete(k);
      // Turn off lines associated with this group if not in other active groups
      const group = LEGEND_GROUPS[k];
      if (group) {
        Object.keys(group).forEach(lc => {
          let inOtherActive = false;
          this.state.legend.groupKeys.forEach(otherGk => {
            if (LEGEND_GROUPS[otherGk] && Object.prototype.hasOwnProperty.call(LEGEND_GROUPS[otherGk], lc)) {
              inOtherActive = true;
            }
          });
          if (!inOtherActive) {
            this.state.lineVisibility[lc] = false;
            delete this.state.directions.waitStartedAtByLine[lc];
            if (this.state.directions.filterByLine) delete this.state.directions.filterByLine[lc];
            if (this.state.directions.overrideModeByLine) delete this.state.directions.overrideModeByLine[lc];
          }
        });
      }
    } else {
      this.state.legend.groupKeys.add(k);
    }

    const active = this.state.legend.groupKeys;
    const affectedLineCodes = new Set();
    active.forEach(gk => {
      const group = LEGEND_GROUPS[gk];
      if (!group || typeof group !== 'object') return;
      Object.keys(group).forEach(lineCode => affectedLineCodes.add(String(lineCode)));
    });

    affectedLineCodes.forEach(lc => {
      if (this.state.directions && this.state.directions.filterByLine) delete this.state.directions.filterByLine[lc];
      if (this.state.directions && this.state.directions.overrideModeByLine) delete this.state.directions.overrideModeByLine[lc];
    });

    this.recomputeGroupDefaultFilters();
    this.applyGroupLineSelections();
    this.saveLegendGroupKeys();
    this.saveActiveLines();
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
            if (k === 'UNI' || k === 'FS' || k === 'BARCOLA') this.state.legend.groupKeys.add(k);
          });
        }
      }
    } catch {
    }

    try {
      const legacy = localStorage.getItem('busmago:legendGroupKey:v1');
      if ((legacy === 'UNI' || legacy === 'FS' || legacy === 'BARCOLA') && this.state.legend.groupKeys.size === 0) {
        this.state.legend.groupKeys.add(legacy);
        localStorage.removeItem('busmago:legendGroupKey:v1');
      }
    } catch {
    }
  }

  saveLegendGroupKeys() {
    try {
      const active = this.state.legend.groupKeys instanceof Set ? Array.from(this.state.legend.groupKeys) : [];
      const filtered = active.filter(k => k === 'UNI' || k === 'FS' || k === 'BARCOLA');
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
    this.loadSkin();
    this.syncThemeColorMeta();
    this.loadFavorites();
    this.loadDeparturesCollapsed();
    this.loadVehicleCollapsed();
    this.initMap();
    this.initToast();
    this.initInstall();
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
    this.renderInfoPanel();

    this.initWelcome();

    // PWA Service Worker registration
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      });
    }

    // Start loop
    this.scheduleNextRefresh(0);

    this.state.uiTimers.infoAgeInterval = setInterval(() => {
      if (this.state.selectedVehicleKey) this.updateInfoAgeBadge();
    }, 1000);
  }

  loadDeparturesCollapsed() {
    try {
      const raw = localStorage.getItem(this.state.departures.storageKey);
      if (raw === '1') {
        this.state.departures.collapsed = true;
        return;
      }
      if (raw === '0') {
        this.state.departures.collapsed = false;
        return;
      }
    } catch {
    }

    const prefersCollapsed = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(max-width: 600px)').matches
      : false;
    this.state.departures.collapsed = prefersCollapsed;
  }

  saveDeparturesCollapsed() {
    try {
      localStorage.setItem(this.state.departures.storageKey, this.state.departures.collapsed ? '1' : '0');
    } catch {
    }
  }

  toggleDeparturesCollapsed() {
    this.state.departures.collapsed = !this.state.departures.collapsed;
    this.saveDeparturesCollapsed();
    this.renderInfoPanel();
  }

  // Collapse del pannello info-vettura (come "Prossime partenze"): comprime corpo
  // e footer lasciando solo l'header (badge linea + destinazione), per liberare
  // schermo su mobile. La preferenza persiste e vale anche per le selezioni successive.
  loadVehicleCollapsed() {
    try {
      const raw = localStorage.getItem(this.state.infoPanel.collapsedStorageKey);
      if (raw === '1') { this.state.infoPanel.collapsed = true; return; }
      if (raw === '0') { this.state.infoPanel.collapsed = false; return; }
    } catch {
    }
  }

  saveVehicleCollapsed() {
    try {
      localStorage.setItem(this.state.infoPanel.collapsedStorageKey, this.state.infoPanel.collapsed ? '1' : '0');
    } catch {
    }
  }

  toggleVehicleCollapsed() {
    this.state.infoPanel.collapsed = !this.state.infoPanel.collapsed;
    this.saveVehicleCollapsed();
    this.renderInfoPanel();
  }

  // Rende un overlay modale accessibile da tastiera: Esc per chiudere, focus
  // intrappolato al suo interno e ripristinato all'elemento di partenza alla
  // chiusura. Ritorna { open, close } da agganciare a show/hide del modale.
  _bindOverlayA11y(overlay, closeFn) {
    if (!overlay) return { open() {}, close() {} };
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    let prevFocus = null;

    const focusables = () => Array.from(overlay.querySelectorAll(FOCUSABLE))
      .filter(el => el.offsetWidth || el.offsetHeight || el.getClientRects().length);

    const onKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // non far chiudere anche la legenda dietro
        closeFn();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = focusables();
      if (!nodes.length) { e.preventDefault(); return; }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !overlay.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !overlay.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    return {
      open() {
        prevFocus = document.activeElement;
        overlay.addEventListener('keydown', onKeydown);
        const nodes = focusables();
        if (nodes.length) {
          nodes[0].focus();
        } else {
          overlay.setAttribute('tabindex', '-1');
          overlay.focus();
        }
      },
      close() {
        overlay.removeEventListener('keydown', onKeydown);
        if (prevFocus && document.contains(prevFocus) && typeof prevFocus.focus === 'function') {
          prevFocus.focus();
        }
        prevFocus = null;
      }
    };
  }

  initWelcome() {
    const WELCOME_KEY = 'busmago:welcomed:v1';
    const overlay = document.getElementById('welcome-overlay');
    const closeBtn = document.getElementById('welcome-close');
    const helpBtn = document.getElementById('help-btn');
    if (!overlay || !closeBtn) return;

    const a11y = this._bindOverlayA11y(overlay, () => dismiss());

    const dismiss = () => {
      overlay.style.display = 'none';
      a11y.close();
      try { localStorage.setItem(WELCOME_KEY, '1'); } catch {}
    };

    const show = () => { overlay.style.display = 'flex'; a11y.open(); };

    closeBtn.addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) dismiss();
    });

    if (helpBtn) {
      helpBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        show();
      });
    }

    try {
      if (localStorage.getItem(WELCOME_KEY) !== '1') show();
    } catch {}
  }

  initInstall() {
    const installBtn = document.getElementById('install-btn');
    const modal = document.getElementById('install-modal');
    const modalClose = document.getElementById('install-modal-close');
    const stepsEl = document.getElementById('install-steps');
    if (!installBtn) return;

    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

    // Già aperta come app installata: nessun bottone d'installazione.
    if (isStandalone) return;

    let deferredPrompt = null;

    // Android/Chrome (e desktop compatibili): intercettiamo il prompt nativo
    // di installazione per offrirlo con UN TAP dal nostro bottone, invece di
    // mandare l'utente a istruzioni esterne.
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.style.display = 'flex';
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      installBtn.style.display = 'none';
      this.showToast('App installata! 🎉', 'success');
    });

    // iOS Safari non espone beforeinstallprompt (Apple non consente
    // l'installazione automatica): mostriamo comunque il bottone, che apre la
    // guida passo-passo in-app.
    if (isIOS) installBtn.style.display = 'flex';

    const shareGlyph = `<svg class="step-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"></path><path d="M8 7l4-4 4 4"></path><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"></path></svg>`;

    const buildSteps = () => {
      if (!stepsEl) return;
      if (isIOS) {
        stepsEl.innerHTML =
          `<div class="welcome-step"><span class="welcome-step-icon">1</span><span class="welcome-step-text">In <strong>Safari</strong>, tocca il tasto <strong>Condividi</strong> ${shareGlyph} nella barra in basso</span></div>` +
          `<div class="welcome-step"><span class="welcome-step-icon">2</span><span class="welcome-step-text">Scorri e scegli <strong>«Aggiungi alla schermata Home»</strong></span></div>` +
          `<div class="welcome-step"><span class="welcome-step-icon">3</span><span class="welcome-step-text">Conferma con <strong>«Aggiungi»</strong>: l'icona comparirà tra le tue app</span></div>`;
      } else {
        stepsEl.innerHTML =
          `<div class="welcome-step"><span class="welcome-step-icon">1</span><span class="welcome-step-text">In <strong>Chrome</strong>, apri il menu <strong>⋮</strong> in alto a destra</span></div>` +
          `<div class="welcome-step"><span class="welcome-step-icon">2</span><span class="welcome-step-text">Tocca <strong>«Installa app»</strong> (o <strong>«Aggiungi a schermata Home»</strong>)</span></div>` +
          `<div class="welcome-step"><span class="welcome-step-icon">3</span><span class="welcome-step-text">Conferma: Bus Mago si aprirà a schermo intero come un'app</span></div>`;
      }
    };

    const a11y = this._bindOverlayA11y(modal, () => closeModal());
    const openModal = () => { buildSteps(); if (modal) { modal.style.display = 'flex'; a11y.open(); } };
    const closeModal = () => { if (modal) { modal.style.display = 'none'; a11y.close(); } };

    installBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (deferredPrompt) {
        // Percorso ottimale: dialog d'installazione nativo, un solo tap.
        deferredPrompt.prompt();
        try {
          const choice = await deferredPrompt.userChoice;
          if (choice && choice.outcome === 'accepted') installBtn.style.display = 'none';
        } catch {}
        deferredPrompt = null;
      } else {
        // Fallback (iOS o browser senza prompt nativo): guida in-app.
        openModal();
      }
    });

    if (modalClose) modalClose.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeModal(); });
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  }

  getTileUrl(themeMode, skinMode) {
    const skin = skinMode || this.state.skin.mode;
    // Classic skin → tile OSM standard (come sul main, niente variante dark).
    if (skin === 'classic') {
      return 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    }
    return themeMode === 'dark'
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
  }

  applyTileLayer() {
    if (!this.state.map) return;
    const isClassic = this.state.skin.mode === 'classic';
    const isDark = this.state.theme.mode === 'dark';
    const url = this.getTileUrl(this.state.theme.mode, this.state.skin.mode);
    const attribution = isClassic
      ? '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
    // Classic usa tile OSM (nessuna variante dark nativa): in tema scuro le
    // scuriamo via filtro CSS, come sul main. Modern usa già le tile CartoDB
    // dark/light, quindi nessun filtro.
    const className = (isClassic && isDark) ? 'dark-mode-tiles' : '';
    if (this.tileLayer) {
      this.state.map.removeLayer(this.tileLayer);
      this.tileLayer = null;
    }
    this.tileLayer = L.tileLayer(url, {
      maxZoom: 19,
      attribution,
      className,
      subdomains: isClassic ? 'abc' : 'abcd',
      keepBuffer: 15,
      updateWhenIdle: false,
      updateWhenZooming: false,
      fadeAnimation: false
    }).addTo(this.state.map);
  }

  initMap() {
    this.state.map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(CONFIG.MAP.DEFAULT_CENTER, CONFIG.MAP.DEFAULT_ZOOM);
    this.applyTileLayer();
    L.control.zoom({ position: 'bottomright' }).addTo(this.state.map);

    // Smooth bus gliding: disable the CSS transition while the map is moving
    // (drag, zoom, or programmatic pan) — otherwise Leaflet's marker
    // repositioning at moveend makes every marker visibly slide. Re-enable on
    // the next frame once the movement has settled.
    const mapEl = this.state.map.getContainer();
    const disableGlide = () => mapEl.classList.add('map-interacting');
    const enableGlide = () => { requestAnimationFrame(() => mapEl.classList.remove('map-interacting')); };
    this.state.map.on('movestart zoomstart', disableGlide);
    this.state.map.on('moveend zoomend', enableGlide);
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

    this.applyTileLayer();
    this.syncThemeColorMeta();

    this.renderLegend();
    this.updateBusMarkers(this.state.lastEnrichedBuses);
  }

  loadSkin() {
    try {
      const raw = localStorage.getItem(this.state.skin.key);
      if (raw === 'classic' || raw === 'modern') this.state.skin.mode = raw;
    } catch {
    }
    document.documentElement.dataset.skin = this.state.skin.mode;
  }

  setSkin(mode) {
    if (mode !== 'classic' && mode !== 'modern') return;
    if (this.state.skin.mode === mode) return;
    this.state.skin.mode = mode;
    document.documentElement.dataset.skin = mode;
    try {
      localStorage.setItem(this.state.skin.key, mode);
    } catch {
    }

    this.applyTileLayer();
    this.syncThemeColorMeta();
    this.renderLegend();
    this.updateBusMarkers(this.state.lastEnrichedBuses);
  }

  // Allinea <meta theme-color> (colore barra di stato del browser/PWA) al --bg
  // EFFETTIVO, che dipende da tema E skin (classic+light è chiaro, glossy è sempre
  // scuro). Prima era fisso su #121212: in tema chiaro la barra restava scura.
  syncThemeColorMeta() {
    try {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (!bg) return;
      let meta = document.querySelector('meta[name="theme-color"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', bg);
    } catch {}
  }

  updateRefreshButtonVisual() {
    const btn = document.getElementById('refresh-btn');
    if (!btn) return;
    // Spin ONLY on a user-triggered hard refresh, never on silent auto-refresh.
    if (this.state.isHardRefreshing) {
      btn.classList.add('refreshing');
    } else {
      btn.classList.remove('refreshing');
    }
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
        localStorage.removeItem('busmago:favorites:v1');
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
        localStorage.removeItem('busmago:activeLines:v1');
      } catch {
      }
    } catch {
    }
  }

  toggleFavorite(key) {
    if (this.state.favorites.set.has(key)) this.state.favorites.set.delete(key);
    else this.state.favorites.set.add(key);
    this.hapticToggle();
    this.saveFavorites();
    this.renderLegend();
  }

  async requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (this.state.wakeLock) return;
    try {
      this.state.wakeLock = await navigator.wakeLock.request('screen');
      this.state.wakeLock.addEventListener('release', () => {
        this.state.wakeLock = null;
      });
    } catch {}
  }

  releaseWakeLock() {
    if (this.state.wakeLock) {
      this.state.wakeLock.release().catch(() => {});
      this.state.wakeLock = null;
    }
  }

  compactStopCache() {
    const now = Date.now();
    Object.keys(this.state.stopCache.entries).forEach(key => {
      if (this.state.stopCache.entries[key].expiresAt < now) {
        delete this.state.stopCache.entries[key];
      }
    });
  }

  // Rate-limiter deterministico: restituisce una Promise che si risolve quando è
  // lecito far partire la PROSSIMA richiesta, distanziando le partenze di
  // 1000/MAX_RPS ms. Converte il Promise.all di un ciclo (decine di fetch
  // simultanee) in uno stream regolare ≤ MAX_RPS req/s, senza burst.
  // ponytail: lock globale a singolo slot; basta e avanza per un solo client.
  _rateSlot() {
    const minGap = 1000 / CONFIG.RATE.MAX_RPS;
    const now = Date.now();
    const at = Math.max(now, this._rateNext || 0);
    this._rateNext = at + minGap;
    const wait = at - now;
    return wait > 0 ? new Promise(r => setTimeout(r, wait)) : Promise.resolve();
  }

  async fetchStopRuns(stopCode, signal = null, ttlMs = CONFIG.CACHE.STOP_RUNS_TTL_MS) {
    const cached = this.state.stopCache.entries[stopCode];
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const inFlight = this.state.stopCache.inFlight[stopCode];
    if (inFlight) return inFlight;

    const fetchOptions = signal ? { signal } : {};
    // Attende lo slot del rate-limiter PRIMA di partire: le N richieste di un ciclo
    // escono spalmate a ≤ MAX_RPS invece che tutte nello stesso istante.
    const p = this._rateSlot().then(() => {
      if (signal && signal.aborted) return cached ? cached.data : [];
      const ts = Date.now();
      return fetch(`https://realtime.tplfvg.it/API/v1.0/polemonitor/mrcruns?StopCode=${stopCode}&IsUrban=true&_=${ts}`, fetchOptions)
        .then(r => r.json())
        .then(data => {
          const normalized = Array.isArray(data) ? data : [];
          this.state.stopCache.entries[stopCode] = { data: normalized, expiresAt: ts + ttlMs };
          return normalized;
        });
    })
      .catch((err) => {
        if (err && err.name === 'AbortError') {
          delete this.state.stopCache.inFlight[stopCode];
          return cached ? cached.data : [];
        }
        const fallback = cached ? cached.data : [];
        this.state.stopCache.entries[stopCode] = { data: fallback, expiresAt: Date.now() + 1000 };
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
        this.hapticTap();
        this.setTheme(this.state.theme.mode === 'dark' ? 'light' : 'dark');
      });
    }

    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hapticTap();
        this.hardRefreshData();
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
        this.releaseWakeLock();
    });
    map.on('click', (e) => {
      this.handleInteraction();
      const oe = e && e.originalEvent ? e.originalEvent : null;
      if (oe && oe._stopped) return;
      const t = oe && oe.target ? oe.target : null;
      if (t && t.closest) {
        if (t.closest('.leaflet-interactive, .leaflet-marker-icon, .leaflet-marker-shadow')) return;
      }
      this.deselectVehicle();
      this.state.isFollowing = false;
      this.releaseWakeLock();
    });

    // Menu toggle
    const menuToggle = document.getElementById('menu-toggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', (e) => {
            if (e) {
              e.preventDefault();
              e.stopPropagation();
            }
            this.hapticTap();
            const willShow = !this.isLegendVisible();
            this.legendDiv.style.display = willShow ? 'block' : 'none';
            if (willShow) this.renderLegend();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (this.isLegendVisible()) {
                this.legendDiv.style.display = 'none';
                menuToggle.focus();
            }
        });
    }

    // Floating search bar — opens legend and filters lines
    const mapSearchInput = document.getElementById('map-search-input');
    if (mapSearchInput) {
      mapSearchInput.addEventListener('input', (e) => {
        this.state.legend.filterText = e.target.value;
        if (!this.isLegendVisible()) {
          this.legendDiv.style.display = 'block';
        }
        this.renderLegend({ skipInfoPanel: true });
      });
      mapSearchInput.addEventListener('focus', () => {
        if (!this.isLegendVisible()) {
          this.legendDiv.style.display = 'block';
          this.renderLegend();
        }
      });
    }

    // Custom zoom buttons (replace Leaflet built-in)
    const zoomInBtn = document.getElementById('zoom-in-btn');
    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        this.hapticTap();
        if (this.state.map) this.state.map.zoomIn();
      });
    }
    const zoomOutBtn = document.getElementById('zoom-out-btn');
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        this.hapticTap();
        if (this.state.map) this.state.map.zoomOut();
      });
    }

    // Handle app visibility changes:
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // When returning to foreground: reset EVERYTHING for fresh data!
        // Reset refresh control flags
        if (this.state.refreshControl.abortController) {
          this.state.refreshControl.abortController.abort();
        }
        this.state.refreshControl.abortController = null;
        this.state.refreshControl.inFlight = false;
        
        // Clear all caches to get fresh data immediately!
        this.state.stopCache = {
          entries: {},
          inFlight: {}
        };
        
        // Reset last known signature for directions to ensure fresh data
        this.state.directions.lastKnownSignature = '';
        
        // Set flag to force fresh data for first refresh!
        this.state.justResumedFromBackground = true;
        
        if (this.state.isFollowing && this.state.selectedVehicleKey) this.requestWakeLock();
        // Force immediate refresh with NO CACHE!
        this.scheduleNextRefresh(0);
      } else {
        // In background: FERMA del tutto il loop. Prima il timer di refresh
        // restava schedulato e continuava a interrogare l'API mentre l'app era
        // "chiusa"/in background — richieste sprecate che bruciavano il budget di
        // rate-limit, così al ritorno in foreground le mrcruns erano già bloccate
        // (vetture congelate). Ora alla riapertura si riparte da zero, pulito.
        if (this.state.uiTimers.refreshTimeout) {
          clearTimeout(this.state.uiTimers.refreshTimeout);
          this.state.uiTimers.refreshTimeout = null;
        }
        if (this.state.refreshControl.abortController) {
          this.state.refreshControl.abortController.abort();
        }
        this.state.refreshControl.inFlight = false;
        this.releaseWakeLock();
      }
    });

    if (this.infoDiv) {
      this.infoDiv.addEventListener('click', (e) => {
        const t = e && e.target ? e.target : null;
        const chipBtn = t && t.closest ? t.closest('.info-line-chip[data-info-line]') : null;
        if (chipBtn) {
          e.preventDefault();
          e.stopPropagation();
          const lc = chipBtn.dataset.infoLine;
          if (lc === this.state.infoPanel.selectedInfoLine) {
            this.clearInfoLine();
          } else {
            this.selectInfoLine(lc);
          }
          return;
        }
        if (t && t.closest && t.closest('#departures-toggle')) {
          e.preventDefault();
          e.stopPropagation();
          this.toggleDeparturesCollapsed();
          return;
        }
        if (t && t.closest && t.closest('#vehicle-collapse-toggle')) {
          e.preventDefault();
          e.stopPropagation();
          this.toggleVehicleCollapsed();
          return;
        }
        if (t && t.closest && (t.closest('#vehicle-deselect-btn') || t.closest('#departures-deselect-btn'))) {
          e.preventDefault();
          e.stopPropagation();
          this.deselectVehicle();
          return;
        }
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
      if (!knownForLine || knownKeys.length <= 1) return;
      const nextSet = new Set();
      knownKeys.forEach(k => {
        if (set.has(k)) nextSet.add(k);
      });
      if (nextSet.size === 0) return;
      filterByLine[lineCode] = nextSet;
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
    if (knownKeys.length >= 2 && next.size >= knownKeys.length) {
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
    const hadVehicle = !!this.state.selectedVehicleKey;
    const hadInfoLine = !!(this.state.infoPanel && this.state.infoPanel.selectedInfoLine);
    if (!hadVehicle && !hadInfoLine) return;
    if (hadVehicle) {
      this.releaseWakeLock();
      this.state.selectedVehicleKey = null;
      if (this.state.departures) this.state.departures.collapsed = true;
    }
    if (this.state.infoPanel) {
      this.state.infoPanel.selectedBus = null;
      this.state.infoPanel.selectedTrack = null;
      this.state.infoPanel.finishedTrip = false;
      this.state.infoPanel.selectedInfoLine = null;
    }
    this.renderInfoPanel();
    this.updateBusMarkers(this.state.lastEnrichedBuses);
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
            this.hapticTap();
            this.suppressMenuAutoCloseUntilMapSettles();
            this.state.map.setView([lastLat, lastLon], 15);
          } else {
            this.showToast("Posizione non ancora rilevata. Controlla i permessi.", "error");
          }
        });
      }
    }
  }

  renderLegend({ skipInfoPanel = false } = {}) {
    if (!this.legendDiv) return;
    const prevScrollTop = this.legendDiv.scrollTop;
    const activeEl = document.activeElement;
    const wasSearchFocused = !!(activeEl && activeEl.id === 'legend-search');
    const searchSelStart = wasSearchFocused ? activeEl.selectionStart : null;
    const searchSelEnd = wasSearchFocused ? activeEl.selectionEnd : null;
    let html = '<div class="sheet-handle" aria-hidden="true"></div>';
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

    // Search is handled by the external #map-search-input in the floating search bar

    // Aspetto (skin) toggle: Moderno | Classico
    const skinMode = this.state.skin.mode === 'classic' ? 'classic' : 'modern';
    html += `<div class="legend-skin-row">
              <span class="legend-skin-label">Aspetto</span>
              <div class="legend-skin-toggle" role="group" aria-label="Scegli aspetto">
                <button type="button" class="legend-skin-opt ${skinMode === 'classic' ? 'is-active' : ''}" data-skin-opt="classic" aria-pressed="${skinMode === 'classic' ? 'true' : 'false'}">Classico</button>
                <button type="button" class="legend-skin-opt ${skinMode === 'modern' ? 'is-active' : ''}" data-skin-opt="modern" aria-pressed="${skinMode === 'modern' ? 'true' : 'false'}">Glossy</button>
              </div>
            </div>`;

    html += `<button id="favorites-only-btn" class="legend-action-btn legend-action-toggle ${favoritesOnly ? 'is-active' : ''}" type="button" aria-pressed="${favoritesOnly ? 'true' : 'false'}">PREFERITI</button>`;

    const filterText = (this.state.legend.filterText || '').trim().toLowerCase();

    // Clear All Button (UI in italiano come il resto del pannello)
    html += `<button id="clear-all-lines">Deseleziona tutte</button>`;

    const groupKeys = (this.state.legend && this.state.legend.groupKeys instanceof Set) ? this.state.legend.groupKeys : new Set();
    const uniActive = groupKeys.has('UNI');
    const fsActive = groupKeys.has('FS');
    const barcolaActive = groupKeys.has('BARCOLA');
    html += `<hr class="legend-grid-separator">`;
    if (skinMode === 'classic') {
      // Layout storico (main): UNI+FS su una riga, BARCOLA centrata sotto (16/9)
      html += `<div class="legend-group-row">
                <button id="legend-group-uni" class="legend-action-btn legend-action-toggle legend-group-btn ${uniActive ? 'is-active' : ''}" type="button" aria-label="Gruppo UNI" aria-pressed="${uniActive ? 'true' : 'false'}"><img class="legend-group-icon" src="img/icona_uni.webp" alt=""></button>
                <button id="legend-group-fs" class="legend-action-btn legend-action-toggle legend-group-btn ${fsActive ? 'is-active' : ''}" type="button" aria-label="Gruppo FS" aria-pressed="${fsActive ? 'true' : 'false'}"><img class="legend-group-icon" src="img/icona_fs.webp" alt=""></button>
              </div>
              <div class="legend-group-row legend-group-row--centered">
                <button id="legend-group-barcola" class="legend-action-btn legend-action-toggle legend-group-btn ${barcolaActive ? 'is-active' : ''}" type="button" aria-label="Gruppo BARCOLA" aria-pressed="${barcolaActive ? 'true' : 'false'}"><img class="legend-group-icon" src="img/barcola.webp" alt=""></button>
              </div>`;
    } else {
      // Layout glossy: tre cerchi a tutta larghezza
      html += `<div class="legend-group-row">
                <button id="legend-group-uni" class="legend-group-btn ${uniActive ? 'is-active' : ''}" type="button" aria-label="Gruppo UNI" aria-pressed="${uniActive ? 'true' : 'false'}"><img class="legend-group-icon" src="img/icona_uni.webp" alt=""></button>
                <button id="legend-group-fs" class="legend-group-btn ${fsActive ? 'is-active' : ''}" type="button" aria-label="Gruppo FS" aria-pressed="${fsActive ? 'true' : 'false'}"><img class="legend-group-icon" src="img/icona_fs.webp" alt=""></button>
                <button id="legend-group-barcola" class="legend-group-btn ${barcolaActive ? 'is-active' : ''}" type="button" aria-label="Gruppo BARCOLA" aria-pressed="${barcolaActive ? 'true' : 'false'}"><img class="legend-group-icon" src="img/barcola.webp" alt=""></button>
              </div>`;
    }
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
    const NIGHT_CODES = ["A", "B", "C", "D"];
    const nowHour = new Date().getHours();
    const isNightTime = nowHour >= 22 || nowHour < 6;
    const rawLines = Array.isArray(linesConfig) ? [...linesConfig] : [];
    const idx17 = rawLines.findIndex(l => l && l.code === '17');
    const idx17s = rawLines.findIndex(l => l && l.code === '17/');
    if (idx17 !== -1 && idx17s !== -1 && idx17 > idx17s) {
      const tmp = rawLines[idx17]; rawLines[idx17] = rawLines[idx17s]; rawLines[idx17s] = tmp;
    }
    // At night, move night lines to the top; by day keep them at the bottom
    const nightLines = rawLines.filter(l => l && NIGHT_CODES.includes(l.code));
    const dayLines   = rawLines.filter(l => l && !NIGHT_CODES.includes(l.code) && l.code !== "777");
    const orderedLines = isNightTime ? [...nightLines, ...dayLines] : [...dayLines, ...nightLines];

    let separatorAdded = false;
    orderedLines.forEach(l => {
      if (l.code === "777") return; // Easter egg line hidden from menu
      // Separator between night and day lines
      if (isNightTime) {
        if (!separatorAdded && !NIGHT_CODES.includes(l.code)) {
          html += '<hr class="legend-grid-separator">';
          separatorAdded = true;
        }
      } else {
        if (!separatorAdded && NIGHT_CODES.includes(l.code)) {
          html += '<hr class="legend-grid-separator">';
          separatorAdded = true;
        }
      }

      const isFavorite = this.state.favorites.set.has(l.code);
      if (favoritesOnly && !isFavorite) return;
      if (filterText) {
        const hay = `${l.code} ${l.label} ${directionsList(l.directions).join(' ')}`.toLowerCase();
        if (!hay.includes(filterText)) return;
      }

      const safeKey = this.escapeHtmlAttribute(l.code);
      const activeClass = this.state.lineVisibility[l.code] ? 'active-line' : '';
      const favSymbol = isFavorite ? '★' : '☆';
      const favClass = isFavorite ? 'is-favorite' : '';
      const title = this.escapeHtmlAttribute(l.label || l.code);
      const pressed = this.state.lineVisibility[l.code] ? 'true' : 'false';
      const tileColor = this.getLegendLineColor(l.code);
      const dirsArr = directionsList(l.directions);
      const dirsText = dirsArr.join(' • ');
      const hasLabel = l.label && l.label !== l.code;
      const lineName = hasLabel ? l.label : (dirsText || l.code);
      const subText = hasLabel ? dirsText : '';
      const listMeta = viewMode === 'list'
        ? `<span class="legend-line-meta"><span class="legend-line-name"><span>${this.escapeHtmlAttribute(lineName)}</span></span>${subText ? `<span class="legend-line-dirs"><span>${this.escapeHtmlAttribute(subText)}</span></span>` : ''}</span>`
        : '';
      html += `<div class="legend-line-tile ${activeClass}" style="--line-color:${tileColor};" title="${title}">
                <button type="button" class="legend-line-select" data-key="${safeKey}" aria-pressed="${pressed}">
                  <span class="legend-line-code">${this.escapeHtmlAttribute(l.code)}</span>
                  ${listMeta}
                </button>
                <button type="button" class="fav-btn legend-line-fav ${favClass}" data-fav="${safeKey}" aria-label="Preferito ${title}">${favSymbol}</button>
              </div>`;
    });
    html += `</div>`;
  
    // "Select All" (excludes line 777)
    const allSelected = Object.keys(this.state.lineVisibility)
      .filter(k => k !== '777')
      .every(k => this.state.lineVisibility[k]);

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
    if (!skipInfoPanel) this.renderInfoPanel();
    if (viewMode === 'list') this._initMarqueeItems();
  }

  _initMarqueeItems() {
    // Continuous ticker: duplicate text so the loop is seamless (span = [text][gap][text]),
    // animate translateX(0 → -50%) at a fixed pixel/s speed so all items scroll equally fast.
    const SPEED_PX_S = 38;   // pixels per second — same for every item
    const GAP = '    •    '; // "    •    "
    requestAnimationFrame(() => {
      const wrappers = this.legendDiv
        ? this.legendDiv.querySelectorAll('.legend-line-name, .legend-line-dirs')
        : [];
      wrappers.forEach(wrapper => {
        const span = wrapper.querySelector('span');
        if (!span) return;
        // Reset to plain text before measuring (strip any previous duplication)
        if (span._tickerOriginal !== undefined) {
          span.textContent = span._tickerOriginal;
        }
        span.classList.remove('scrolling');
        span.style.removeProperty('--ticker-dur');
        const textW = span.scrollWidth;
        const containerW = wrapper.clientWidth;
        if (textW <= containerW + 4) return; // fits — no ticker needed
        // Store original and duplicate: [text][gap][text]
        span._tickerOriginal = span.textContent;
        span.textContent = span._tickerOriginal + GAP + span._tickerOriginal;
        // One "cycle" = scrollWidth/2 pixels (one copy + one gap)
        const oneCycleW = span.scrollWidth / 2;
        const dur = oneCycleW / SPEED_PX_S;
        span.style.setProperty('--ticker-dur', `${dur.toFixed(2)}s`);
        span.classList.add('scrolling');
      });
    });
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
        clearTimeout(this._searchDebounce);
        this._searchDebounce = setTimeout(() => {
          this.renderLegend({ skipInfoPanel: true });
          const next = document.getElementById('legend-search');
          if (next) {
            next.focus();
            if (typeof start === 'number' && typeof end === 'number') next.setSelectionRange(start, end);
          }
        }, 80);
      });
    }

    const viewToggle = document.getElementById('legend-view-toggle');
    if (viewToggle) {
      viewToggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.state.legend.viewMode = this.state.legend.viewMode === 'list' ? 'grid' : 'list';
        this.saveLegendView();
        this.renderLegend({ skipInfoPanel: true });
      });
    }

    this.legendDiv.querySelectorAll('[data-skin-opt]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setSkin(btn.dataset.skinOpt);
      });
    });

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
            this.hapticSuccess();
            if (this.state.legend.groupKeys instanceof Set) this.state.legend.groupKeys.clear();
            this.recomputeGroupDefaultFilters();
            this.saveLegendGroupKeys();
            Object.keys(this.state.lineVisibility).forEach(k => {
              this.state.lineVisibility[k] = false;
              if (this.legendDiv.dataset.favoritesOnly === '1' && this.state.favorites.snapshot) {
                this.state.favorites.snapshot[k] = false;
              }
            });
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
      const allSelectedNow = Object.keys(this.state.lineVisibility)
        .filter(k => k !== '777')
        .every(k => this.state.lineVisibility[k] === true);
      selectAllBtn.classList.toggle('is-active', allSelectedNow);
      selectAllBtn.setAttribute('aria-pressed', allSelectedNow ? 'true' : 'false');

      selectAllBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        this.hapticSuccess();
        const allSelectedNext = !Object.keys(this.state.lineVisibility)
          .filter(k => k !== '777')
          .every(k => this.state.lineVisibility[k] === true);
        const lineButtons = this.legendDiv.querySelectorAll('button.legend-line-select[data-key]');

        const now = Date.now();
        lineButtons.forEach(btn => {
          const k = btn.getAttribute('data-key');
          if (!k || k === '777') return;
          this.state.lineVisibility[k] = allSelectedNext;
          if (this.legendDiv.dataset.favoritesOnly === '1' && this.state.favorites.snapshot) {
            this.state.favorites.snapshot[k] = allSelectedNext;
          }
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

        this.hapticToggle();
        this.preserveLegendScrollByLineKey(k, () => {
          const next = !this.state.lineVisibility[k];
          this.state.lineVisibility[k] = next;
          if (this.legendDiv.dataset.favoritesOnly === '1' && this.state.favorites.snapshot) {
            this.state.favorites.snapshot[k] = next;
          }
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
            const allSelectedNow = Object.keys(this.state.lineVisibility)
              .filter(key => key !== '777')
              .every(key => this.state.lineVisibility[key] === true);
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

    const groupBarcolaBtn = document.getElementById('legend-group-barcola');
    if (groupBarcolaBtn) {
      groupBarcolaBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleLegendGroupKey('BARCOLA');
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
        this.renderLegend({ skipInfoPanel: true });
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

    if (activeLineCount > CONFIG.REFRESH.MANY_LINES_THRESHOLD) return CONFIG.REFRESH.MANY_LINES_MS;
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

  async hardRefreshData() {
    this.state.isHardRefreshing = true;
    this.updateRefreshButtonVisual();

    // 1. Clear all markers from map
    Object.values(this.state.busMarkers).forEach(marker => {
      if (marker && this.state.map) {
        this.state.map.removeLayer(marker);
      }
    });
    this.state.busMarkers = {};

    // 2. Clear track layers
    Object.values(this.state.routeLayers).forEach(layer => {
      if (layer && this.state.map) {
        this.state.map.removeLayer(layer);
      }
    });
    this.state.routeLayers = {};

    // 3. Clear endpoint markers
    Object.values(this.state.routeEndpointMarkers).forEach(markers => {
      markers.forEach(marker => {
        if (marker && this.state.map) {
          this.state.map.removeLayer(marker);
        }
      });
    });
    this.state.routeEndpointMarkers = {};

    // 4. Clear vehicle state and other data
    this.state.vehicleState = {};
    this.state.lastEnrichedBuses = [];
    this.state.lastStopDataMap = null;
    this.state.stopCache = {
      entries: {},
      inFlight: {}
    };
    this.state.trackRefreshCounters = {};
    this.state.lastRaces = {};
    this.state.visibleTrackKeys = new Set();
    this.state.directions.knownByLine = {};
    this.state.directions.lastKnownSignature = '';

    // 5. Update UI
    this.updateBusMarkers([]);
    this.updateTrackStyles();
    this.renderLegend({ skipInfoPanel: true });

    // 6. Now do a fresh data fetch
    await this.refreshData();

    // 7. Done
    this.state.isHardRefreshing = false;
    this.updateRefreshButtonVisual();
  }

  async refreshData() {
    // Safety check: if inFlight has been stuck for too long, reset it
    // This prevents the app from freezing if visibility change missed something
    if (this.state.refreshControl.inFlight) {
      const now = Date.now();
      const lastSuccess = this.state.updateStatus.lastSuccessAt;
      const lastError = this.state.updateStatus.lastErrorAt;
      const lastActivity = Math.max(lastSuccess, lastError);
      const timeSinceLastActivity = lastActivity > 0 ? (now - lastActivity) : 30000;

      // If no activity for more than 30 seconds, reset inFlight flag
      if (timeSinceLastActivity > 30000) {
        this.state.refreshControl.inFlight = false;
      } else {
        this.scheduleNextRefresh(this.getRefreshIntervalMs());
        return;
      }
    }
    
    if (this.state.refreshControl.abortController) {
      this.state.refreshControl.abortController.abort();
    }
    const controller = new AbortController();
    this.state.refreshControl.abortController = controller;

    const requestId = ++this.state.refreshControl.requestSeq;
    this.state.refreshControl.inFlight = true;

    // Salvaguardia anti-stallo: senza un timeout, se anche UNA sola fermata non
    // risponde, Promise.all resterebbe appesa e il ciclo non si chiuderebbe,
    // bloccando ogni refresh successivo fino al reset di sicurezza a 30s (cicli
    // congelati, posizioni vecchie). Allo scadere abortiamo le richieste lente:
    // fetchStopRuns intercetta l'AbortError e restituisce l'ultimo dato in cache,
    // così il ciclo si chiude con i dati parziali già arrivati e riparte in tempo.
    const cycleTimeoutMs = Math.max(3000, this.getRefreshIntervalMs() + 1500);
    const cycleDeadline = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, cycleTimeoutMs);

    try {
        const activeLineCount = Object.keys(this.state.lineVisibility).filter(k => this.state.lineVisibility[k] === true).length;
        
        // Quante fermate interrogare per linea. lines.js contiene l'elenco
        // COMPLETO ordinato spazialmente (capolinea agli estremi), quindi va
        // SEMPRE campionato per non interrogarne centinaia. Il campionamento per
        // indice include sempre il primo e l'ultimo (= i due capolinea) piu'
        // alcuni intermedi distribuiti lungo il percorso: basta per intercettare
        // tutti i bus in servizio senza sovraccaricare l'API.
        // Densita' di campionamento DERIVATA DA UN BUDGET: dividiamo il tetto di
        // fetch/ciclo per il numero di linee attive (clamp fra MIN e MAX). Cosi'
        // con ~5 linee (caso tipico) ogni linea ottiene la copertura massima,
        // mentre salendo di linee le fermate per linea scendono in modo graduale
        // mantenendo il totale entro ~FETCH_BUDGET. I capolinea sono comunque
        // sempre interrogati a parte (vedi sotto).
        const { FETCH_BUDGET, MIN_STOPS_PER_LINE, MAX_STOPS_PER_LINE } = CONFIG.SAMPLING;
        const stopsLimitPerLine = Math.max(
            MIN_STOPS_PER_LINE,
            Math.min(MAX_STOPS_PER_LINE, Math.round(FETCH_BUDGET / Math.max(1, activeLineCount)))
        );

        // Due insiemi separati per PRIORITIZZARE i capolinea nello stream a budget:
        // i capolinea (dove converge ogni corsa) vengono richiesti PRIMA delle fermate
        // intermedie campionate, così prendono gli slot iniziali del rate-limiter e
        // restano freschi anche se il deadline del ciclo taglia la coda sotto carico.
        const terminalStops = new Set();
        const sampleStops = new Set();
        let hasActiveLines = false;

        linesConfig.forEach(l => {
            const isLineActive = this.state.lineVisibility[l.code] === true;

            if (isLineActive) {
                hasActiveLines = true;
                
                // Campiona le fermate lungo il percorso (ordinate spazialmente).
                // Campionamento UNIFORME: minimizza il gap massimo fra due fermate
                // interrogate, che e' cio' che determina se un bus "sfugge" (mrcruns
                // riporta una corsa solo se la fermata e' ancora davanti al bus, entro
                // 2-4 corse). Una distribuzione uniforme garantisce la copertura
                // peggiore migliore lungo TUTTO il percorso, inclusi i tratti subito
                // dopo i capolinea (dove il bus appena partito non e' piu' davanti al
                // capolinea di partenza). Garantiamo inoltre un numero di fermate
                // DISTINTE pari al target: avanziamo all'indice libero piu' vicino in
                // caso di collisione di arrotondamento (prima il Set ne perdeva diverse).
                const src = Array.isArray(l.stops) ? l.stops : [];
                let stopsToUse;
                if (src.length <= stopsLimitPerLine) {
                    stopsToUse = src;
                } else if (stopsLimitPerLine <= 1) {
                    stopsToUse = [src[0]];
                } else {
                    const lastIdx = src.length - 1;
                    const seen = new Set();
                    const picked = [];
                    for (let i = 0; i < stopsLimitPerLine; i++) {
                        let idx = Math.round((i / (stopsLimitPerLine - 1)) * lastIdx);
                        while (seen.has(idx) && idx < lastIdx) idx++;
                        while (seen.has(idx) && idx > 0) idx--;
                        if (seen.has(idx)) continue;
                        seen.add(idx);
                        picked.push(src[idx]);
                    }
                    stopsToUse = picked;
                }

                stopsToUse.forEach(s => sampleStops.add(s));

                // Interroga SEMPRE i capolinea: li' convergono tutti i bus della
                // linea (ogni corsa e' diretta a un capolinea), quindi garantiscono
                // di intercettare ogni vettura indipendentemente dal campionamento.
                // Vanno nel set prioritario (richiesti per primi).
                if (Array.isArray(l.terminals)) l.terminals.forEach(s => terminalStops.add(s));
            }
        });

        // If no lines are active, clear markers
        if (!hasActiveLines) {
            this.updateBusMarkers([]); 
            this.updateTrackStyles();
            return;
        }

        if (requestId !== this.state.refreshControl.requestSeq) return;

        // Ordine = capolinea PRIMA, poi le intermedie non già coperte. Il rate-limiter
        // assegna gli slot nell'ordine di questo array, quindi i capolinea partono per primi.
        const stopsList = [...terminalStops, ...[...sampleStops].filter(s => !terminalStops.has(s))];

        // 2. Fetch data (Async/Await)
        // TTL dinamico: leggermente inferiore all'intervallo di refresh così
        // ogni ciclo riceve dati freschi (no cache stantia durante il follow),
        // ma resta alto con molte linee per non sovraccaricare l'API.
        // If we just resumed from background, FORCE 0 TTL to get fresh data!
        let ttlMs;
        if (this.state.justResumedFromBackground) {
          ttlMs = 0; // Force fresh data!
          this.state.justResumedFromBackground = false; // Clear flag after this refresh!
        } else {
          ttlMs = Math.max(1000, this.getRefreshIntervalMs() - 500);
        }
        const requests = stopsList.map(code => this.fetchStopRuns(code, controller.signal, ttlMs));
        const results = await Promise.all(requests);

        if (requestId !== this.state.refreshControl.requestSeq) return;

        // Map results
        const stopDataMap = {};
        stopsList.forEach((code, idx) => {
            stopDataMap[code] = Array.isArray(results[idx]) ? results[idx] : [];
        });
        this.state.lastStopDataMap = stopDataMap;

        // 3. Process Vehicles
        // Passata unica su tutte le fermate: la linea di ogni corsa viene risolta
        // con una mappa O(1) per LineCode invece di re-iterare linesConfig per ogni
        // corsa (prima era O(linee × fermate × corse)). La mappa e' costante e
        // viene costruita una sola volta.
        if (!this._lineByCode) {
            this._lineByCode = new Map(linesConfig.map(l => [String(l.code).toUpperCase(), l]));
        }
        const lineByCode = this._lineByCode;
        const buses = [];
        Object.keys(stopDataMap).forEach(sCode => {
            const runs = stopDataMap[sCode];
            runs.forEach(r => {
                const code = (r.LineCode || "").toUpperCase();
                const lineConf = lineByCode.get(code);
                if (!lineConf) return;
                const lat = r.Latitude || 0;
                const lon = r.Longitude || 0;
                if (lat === 0 || lon === 0) return;
                buses.push({
                    coords: [lat, lon],
                    vehicle: r.Vehicle || "",
                    race: String(r.Race || ""),
                    direction: r.Direction || "",
                    destination: r.Destination || "",
                    departure: r.Departure || "",
                    note: r.Note || "",
                    isStarted: r.IsStarted !== false,
                    nextPasses: r.NextPasses || "",
                    scheduledTime: r.Time || "",
                    arrivalRaw: r.ArrivalTime || "",
                    lineLabel: lineConf.label,
                    lineColor: this.getLegendLineColor(lineConf.code),
                    lineCode: lineConf.code,
                    detectedAtStop: sCode
                });
            });
        });

        // 4. Deduplicate and Enrich
        // The same vehicle appears at multiple stops, sometimes with different
        // destinations (e.g. limited runs). Prefer the record that carries a
        // Race (a real in-service run) instead of arbitrarily keeping the last.
        const byVehicle = {};
        buses.forEach(b => {
            const k = b.vehicle || `NO_VEHICLE_${b.coords[0]}_${b.coords[1]}`;
            const existing = byVehicle[k];
            if (!existing) { byVehicle[k] = b; return; }
            if (!existing.race && b.race) byVehicle[k] = b;
        });

        const uniqueBuses = Object.values(byVehicle);

        const enriched = uniqueBuses.map(b => {
            const key = b.key || b.vehicle || `NO_VEHICLE_${b.coords[0]}_${b.coords[1]}`;
            const prev = this.state.vehicleState[key];
            let heading = (prev && typeof prev.heading === 'number') ? prev.heading : 0;
            let headingFromMove = prev ? !!prev.headingFromMove : false;
            const moved = !prev || prev.lat !== b.coords[0] || prev.lon !== b.coords[1];

            if (prev && prev.lat !== undefined && (prev.lat !== b.coords[0] || prev.lon !== b.coords[1])) {
                // Movimento osservato fra due cicli: è l'orientamento più affidabile.
                heading = this.computeBearing(prev.lat, prev.lon, b.coords[0], b.coords[1]);
                headingFromMove = true;
            } else if (!headingFromMove) {
                // Prima apparizione (o vettura ancora ferma): non sappiamo ancora da
                // dove arriva, ma sappiamo dove va. Orientiamo l'icona lungo il
                // tracciato verso la destinazione, così non punta mai "in su" di
                // default. Resta valido finché il movimento reale non subentra.
                const t = this.computeTrackHeading(b.lineCode, b.destination, b.coords[0], b.coords[1]);
                if (t != null) heading = t;
            }

            this.state.vehicleState[key] = {
              lat: b.coords[0],
              lon: b.coords[1],
              heading: heading,
              headingFromMove: headingFromMove,
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

        this.updateBusMarkers(enriched);

        // Update selected info
        if (this.state.selectedVehicleKey) {
            selected = enriched.find(b => b.key === this.state.selectedVehicleKey);
        }
        this.state.updateStatus.lastSuccessAt = Date.now();
        this.state.updateStatus.lastErrorMessage = '';

        if (selected && selected.key === this.state.selectedVehicleKey && selected.moved) {
          this.state.updateStatus.lastSelectedMoveAt = Date.now();
          // aggiornamento posizione del bus seguito: micro-vibrazione discreta.
          // Solo durante il follow attivo, per non disturbare a ogni ciclo.
          if (this.state.isFollowing) this.hapticFeedback(12);
        }

        this.updateInfoFromBus(selected);

    } catch (err) {
        this.state.updateStatus.lastErrorAt = Date.now();
        this.state.updateStatus.lastErrorMessage = (err && err.message) ? String(err.message) : 'Errore di connessione';
        console.error("Errore aggiornamento dati", err);
        this.showToast("Errore di connessione. Riprovo...", "error");
        this.renderInfoPanel();
    } finally {
        clearTimeout(cycleDeadline);
        if (requestId >= this.state.refreshControl.lastAppliedRequestSeq) {
          this.state.refreshControl.lastAppliedRequestSeq = requestId;
        }
        this.state.refreshControl.inFlight = false;
        this.compactStopCache();
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

            const counter = this.state.trackRefreshCounters[trackKey] || 0;
            // La geometria del tracciato di una linea/direzione è STATICA: NON va
            // riscaricata a ogni cambio di Race (prima il refetch su `race !==
            // prevRace` causava decine di richieste LineGeoTrack sprecate, perché
            // la corsa "più vicina" cambia di continuo mentre i bus avanzano).
            // Scarichiamo una sola volta per trackKey, poi rinfreschiamo solo
            // periodicamente (ogni TRACK_REFRESH_INTERVAL cicli) come sicurezza
            // contro deviazioni/varianti di percorso.
            const shouldFetch = race && (!this.state.routeLayers[trackKey] || counter >= CONFIG.REFRESH.TRACK_REFRESH_INTERVAL);

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

            if (this.state.trackFetchControllers[trackKey]) {
              this.state.trackFetchControllers[trackKey].abort();
            }
            const trackController = new AbortController();
            this.state.trackFetchControllers[trackKey] = trackController;

            fetch(url, { signal: trackController.signal })
                .then(r => r.json())
                .then(track => {
                    delete this.state.trackFetchControllers[trackKey];
                    if (!this.state.visibleTrackKeys.has(trackKey)) return;
                    if (Array.isArray(track)) this.updateTrackLayer(trackKey, lineConf, destination, track);
                })
                .catch(err => {
                    if (err && err.name === 'AbortError') return;
                    delete this.state.trackFetchControllers[trackKey];
                    console.error(`Errore caricamento tracciato ${trackKey}`, err);
                });
        });
    });

    // Prune stale counters and abort pending fetches for track keys no longer active
    Object.keys(this.state.trackRefreshCounters).forEach(key => {
      if (!visible.has(key)) {
        if (this.state.trackFetchControllers[key]) {
          this.state.trackFetchControllers[key].abort();
          delete this.state.trackFetchControllers[key];
        }
        delete this.state.trackRefreshCounters[key];
        delete this.state.lastRaces[key];
      }
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
              const oe = e && e.originalEvent ? e.originalEvent : e;
              if (oe) {
                L.DomEvent.preventDefault(oe);
                L.DomEvent.stopPropagation(oe);
              }
              this.state.selectedVehicleKey = "TRACK_" + trackKey;
              if (this.state.departures) this.state.departures.collapsed = false;
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
              const startMarker = L.marker(pts[0], { icon: startIcon }).addTo(this.state.map);
              const endMarker = L.marker(pts[pts.length - 1], { icon: endIcon }).addTo(this.state.map);
              [startMarker, endMarker].forEach(m => {
                m.off('click');
                m.on('click', (e) => {
                  const oe = e && e.originalEvent ? e.originalEvent : e;
                  if (oe) {
                    L.DomEvent.preventDefault(oe);
                    L.DomEvent.stopPropagation(oe);
                  }
                  this.state.selectedVehicleKey = "TRACK_" + trackKey;
                  if (this.state.departures) this.state.departures.collapsed = false;
                  this.updateInfoFromTrack(lineConf, dir);
                  if (this.legendDiv.style.display === 'block') {
                    this.legendDiv.style.display = 'none';
                  }
                  this.updateBusMarkers(this.state.lastEnrichedBuses);
                });
              });
              endpoints.push(startMarker);
              endpoints.push(endMarker);
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
              const oe = e && e.originalEvent ? e.originalEvent : e;
              if (oe) {
                L.DomEvent.preventDefault(oe);
                L.DomEvent.stopPropagation(oe);
              }
              this.state.selectedVehicleKey = "TRACK_" + trackKey;
              if (this.state.departures) this.state.departures.collapsed = false;
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
          const startMarker = L.circleMarker(start, { radius: 6, color: paletteColor, fillColor: paletteColor, fillOpacity: 1, weight: 2 }).addTo(this.state.map);
          const endMarker = L.circleMarker(end, { radius: 6, color: paletteColor, fillColor: paletteColor, fillOpacity: 1, weight: 2 }).addTo(this.state.map);
          [startMarker, endMarker].forEach(m => {
            m.off('click');
            m.on('click', (e) => {
              const oe = e && e.originalEvent ? e.originalEvent : e;
              if (oe) {
                L.DomEvent.preventDefault(oe);
                L.DomEvent.stopPropagation(oe);
              }
              this.state.selectedVehicleKey = "TRACK_" + trackKey;
              if (this.state.departures) this.state.departures.collapsed = false;
              this.updateInfoFromTrack(lineConf, destination);
              if (this.legendDiv.style.display === 'block') {
                this.legendDiv.style.display = 'none';
              }
              this.updateBusMarkers(this.state.lastEnrichedBuses);
            });
          });
          endpoints.push(startMarker);
          endpoints.push(endMarker);
      }
      this.state.routeEndpointMarkers[trackKey] = endpoints;

      this.updateTrackStyles();

      // Il tracciato è appena arrivato: orienta subito le vetture che erano
      // apparse prima che fosse pronto (così non restano puntate "in su").
      this.reorientStationaryBuses();
  }

  updateBusMarkers(buses) {
    this.state.lastEnrichedBuses = buses || [];
    const newKeys = new Set();
    
    const zoom = this.state.map ? this.state.map.getZoom() : CONFIG.MAP.DEFAULT_ZOOM;
    const zoomScale = this.getBusIconZoomScale(zoom);
    const showLabel = this.shouldShowBusLabel(zoom);

    const activeLineCount = Object.keys(this.state.lineVisibility).filter(k => this.state.lineVisibility[k] === true).length;
    const useSmallIcons = activeLineCount >= CONFIG.UI.SMALL_ICON_THRESHOLD;
    // Teardrop ("goccia") marker — square box, border-radius makes the drop shape
    const dropSize = useSmallIcons ? 30 : 44;
    const iconSize = [dropSize, dropSize];
    const iconAnchor = [Math.floor(dropSize / 2), Math.floor(dropSize / 2)];
    const sizeClass = useSmallIcons ? 'small' : 'large';

    if (buses && buses.length > 0) {
      buses.forEach(b => {
        if (this.state.lineVisibility[b.lineCode] !== true) return;
        if (!this.isDirectionAllowed(b.lineCode, b.destination)) return;

        newKeys.add(b.key);

        const paletteColor = this.getLegendLineColor(b.lineCode);
        const isClassicSkin = this.state.skin.mode === 'classic';
        const isLightDay = this.state.theme.mode === 'light';
        // TEST palette — Glossy + giorno: goccia pastello + numero scuro unico
        // (un solo colore-testo per tutte le linee, alto contrasto sui pastelli).
        const glossyDay = !isClassicSkin && isLightDay;
        const labelTextColor = glossyDay ? '#262a36' : (isLightDay ? '#111' : '#fff');

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

        let opacity = (this.state.selectedVehicleKey && !isSelected) ? 0.3 : 1.0;
        // Il dimming per linea-info vale solo quando NON c'è una vettura selezionata
        // (la selezione vettura ha la precedenza sulla sovrimpressione di linea).
        if (!this.state.selectedVehicleKey && this.state.infoPanel.selectedInfoLine && b.lineCode !== this.state.infoPanel.selectedInfoLine) {
          opacity = 0.35;
        }
        const heading = typeof b.heading === 'number' ? b.heading : 0;
        const hasHeading = typeof b.heading === 'number';
        const selectionBorderColor = this.state.theme.mode === 'light' ? '#111' : '#FFF';
        const borderStyle = isSelected ? `border: 3px solid ${selectionBorderColor};` : '';
        const labelText = showLabel ? b.lineLabel : '';
        // Classic: tinta piena. Glossy notte: gradiente lucido saturo.
        // Glossy giorno (TEST): goccia pastello (colore linea molto schiarito).
        let dropBg;
        if (isClassicSkin) {
          dropBg = paletteColor;
        } else if (glossyDay) {
          dropBg = `radial-gradient(120% 120% at 32% 22%, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 52%), linear-gradient(150deg, color-mix(in srgb, ${paletteColor} 34%, #fff) 0%, color-mix(in srgb, ${paletteColor} 50%, #fff) 55%, color-mix(in srgb, ${paletteColor} 64%, #fff) 100%)`;
        } else {
          dropBg = `radial-gradient(120% 120% at 32% 22%, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0) 46%), linear-gradient(150deg, color-mix(in srgb, ${paletteColor} 76%, #fff) 0%, ${paletteColor} 54%, color-mix(in srgb, ${paletteColor} 86%, #000) 100%)`;
        }
        // Teardrop: border-radius 50% 50% 50% 0 has a sharp corner at bottom-left
        // (pointing SW = 225°). Rotating by heading+135° aims that point toward the
        // travel direction. With no heading we keep a plain circle (no false point).
        // The wrapper rotates+scales; the number counter-rotates to stay upright.
        const dropRot = hasHeading ? (heading + 135) : 0;
        const dropRadius = hasHeading ? '50% 50% 50% 0' : '50%';
        const iconHtml = `<div class="bus-marker-wrap" style="transform:rotate(${dropRot}deg) scale(${zoomScale});opacity:${opacity}"><div class="bus-drop ${sizeClass}" style="background:${dropBg};border-radius:${dropRadius};${borderStyle}"><span style="transform:rotate(${-dropRot}deg);color:${labelTextColor};">${labelText}</span></div></div>`;

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
                    const wrap = el.querySelector('.bus-marker-wrap');
                    const iconDiv = wrap && wrap.querySelector('.bus-drop');
                    if (wrap && iconDiv) {
                        wrap.style.transform = `rotate(${dropRot}deg) scale(${zoomScale})`;
                        wrap.style.opacity = String(opacity);
                        iconDiv.style.background = dropBg;
                        iconDiv.style.borderRadius = dropRadius;
                        iconDiv.style.border = isSelected ? `3px solid ${selectionBorderColor}` : '';
                        const span = iconDiv.querySelector('span');
                        if (span) {
                            if (span.textContent !== labelText) span.textContent = labelText;
                            span.style.transform = `rotate(${-dropRot}deg)`;
                            span.style.color = labelTextColor;
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

             // Bind the click handler ONCE. It resolves the current bus by key
             // from vehicleState at click-time, so it never needs re-binding.
             const markerKey = b.key;
             marker.on('click', (e) => {
                 const oe = e && e.originalEvent ? e.originalEvent : e;
                 if (oe) {
                   L.DomEvent.preventDefault(oe);
                   L.DomEvent.stopPropagation(oe);
                 }
                 this.state.selectedVehicleKey = markerKey;
                 this.state.updateStatus.lastSelectedMoveAt = 0;
                 this.state.isFollowing = true;
                 this.hapticSelect(); // selezione bus: vibrazione netta
                 this.requestWakeLock();
                 const cur = (this.state.vehicleState[markerKey] && this.state.vehicleState[markerKey].lastEnrichedBus) || null;
                 if (cur && cur.coords) {
                   this.state.lastFollowCoords = [cur.coords[0], cur.coords[1]];
                   this.state.map.panTo(cur.coords, { animate: true });
                 }
                 this.updateInfoFromBus(cur);
                 if (this.legendDiv.style.display === 'block') {
                     this.legendDiv.style.display = 'none';
                 }
                 this.updateBusMarkers(this.state.lastEnrichedBuses);
             });
        }

        // Follow logic: la mappa scorre INSIEME al bus seguito non appena si
        // muove, tenendolo centrato. Per non litigare con la gente che trascina
        // la mappa, ripaniamo solo quando le coordinate del bus CAMBIANO davvero
        // rispetto all'ultima posizione su cui abbiamo centrato (un refresh in
        // cui il bus è fermo non sposta la vista). La micro-soglia evita pan
        // inutili per oscillazioni GPS sotto il metro.
        if (isSelected && this.state.isFollowing && !this.state.selectedVehicleKey.startsWith("TRACK_")) {
            const map = this.state.map;
            const last = this.state.lastFollowCoords;
            const moved = !last ||
                Math.abs(last[0] - b.coords[0]) > 1e-5 ||
                Math.abs(last[1] - b.coords[1]) > 1e-5;
            if (moved) {
                this.state.lastFollowCoords = [b.coords[0], b.coords[1]];
                map.panTo(b.coords, { animate: true, duration: 0.8, easeLinearity: 0.25 });
            }
        }
      });
    }

    // Remove old markers and stale vehicle state
    Object.keys(this.state.busMarkers).forEach(key => {
        if (!newKeys.has(key)) {
            this.state.map.removeLayer(this.state.busMarkers[key]);
            delete this.state.busMarkers[key];
        }
    });
    Object.keys(this.state.vehicleState).forEach(key => {
        if (!newKeys.has(key)) delete this.state.vehicleState[key];
    });

    this.updateTrackStyles();
    // Update fleet chip bar in info panel whenever bus data changes
    this.renderInfoPanel();
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
        } else if (this.state.infoPanel.selectedInfoLine && lineCode !== this.state.infoPanel.selectedInfoLine) {
            opacity = 0.35;
        } else if (this.state.infoPanel.selectedInfoLine && lineCode === this.state.infoPanel.selectedInfoLine) {
            layer.bringToFront();
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
                iconUrl: 'img/icona_bateo_gambling.webp',
                iconSize: [40, 40],
                iconAnchor: [20, 20],
                className: 'bateo-icon' // abilita la transizione fluida 2s (CSS)
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
      if (this.state.selectedVehicleKey && !this.state.selectedVehicleKey.startsWith('TRACK_')) {
        this.state.infoPanel.selectedBus = null;
        this.state.infoPanel.selectedTrack = null;
        this.state.infoPanel.finishedTrip = true;
      } else {
        this.state.infoPanel.selectedBus = null;
        this.state.infoPanel.finishedTrip = false;
      }
      this.renderInfoPanel();
      return;
    }

    if (this.state.selectedVehicleKey && this.state.selectedVehicleKey.startsWith('TRACK_')) {
      this.state.infoPanel.selectedTrack = null;
    }
    this.state.infoPanel.selectedBus = bus;
    this.state.infoPanel.finishedTrip = false;
    this.renderInfoPanel();
  }

  updateInfoAgeBadge() {
    if (!this.infoDiv || this.infoDiv.style.display === 'none') return;
    const vehicleRoot = this.infoDiv.querySelector('.vehicle-info');
    if (!vehicleRoot) return;
    const badge = vehicleRoot.querySelector('#info-update-badge');
    const timeSpan = vehicleRoot.querySelector('.info-footer span:last-child');
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

    const ageSec = lastSuccessAt ? Math.max(0, Math.floor((now - lastSuccessAt) / 1000)) : null;
    badge.textContent = `Aggiornato ${ageSec === null ? '?' : ageSec}s fa`;
    badge.style.background = 'rgba(60, 180, 120, 0.15)';
    badge.style.border = '1px solid rgba(60, 180, 120, 0.4)';

    if (timeSpan && lastSuccessAt) {
      const dt = new Date(lastSuccessAt);
      timeSpan.textContent = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}`;
    }
  }

  updateInfoFromTrack(lineConf, direction) {
    if (!lineConf) {
      this.state.infoPanel.selectedTrack = null;
      this.renderInfoPanel();
      return;
    }
    this.state.infoPanel.selectedBus = null;
    this.state.infoPanel.finishedTrip = false;
    this.state.infoPanel.selectedTrack = {
      lineCode: String(lineConf.code || ''),
      lineLabel: String(lineConf.label || lineConf.code || ''),
      destination: String(direction || '')
    };
    this.renderInfoPanel();
  }

  buildFleetChipsHtml() {
    const buses = this.state.lastEnrichedBuses || [];
    if (!buses.length) return '';
    const byLine = {};
    buses.forEach(b => {
      if (this.state.lineVisibility[b.lineCode] !== true) return;
      const key = b.lineLabel || String(b.lineCode || '?');
      if (!byLine[key]) byLine[key] = { count: 0, color: this.getLegendLineColor(b.lineCode) };
      byLine[key].count++;
    });
    const entries = Object.entries(byLine);
    if (!entries.length) return '';
    const isClassicSkin = this.state.skin.mode === 'classic';
    const chips = entries.map(([label, { count, color }]) => {
      const bg = isClassicSkin
        ? color
        : `radial-gradient(120% 120% at 30% 20%, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0) 48%), linear-gradient(150deg, color-mix(in srgb, ${color} 78%, #fff) 0%, ${color} 58%, color-mix(in srgb, ${color} 88%, #000) 100%)`;
      return `<span class="fleet-chip" style="background:${bg}"><span class="fleet-chip-code">${this.escapeHtmlAttribute(label)}</span><span class="fleet-chip-count">${count}</span></span>`;
    }).join('');
    return `<div class="fleet-chips-wrap"><div class="fleet-chips-bar">${chips}</div></div>`;
  }

  selectInfoLine(lineCode) {
    this.state.infoPanel.selectedInfoLine = lineCode || null;
    this.renderInfoPanel();
    this.updateBusMarkers(this.state.lastEnrichedBuses);
  }

  clearInfoLine() {
    this.state.infoPanel.selectedInfoLine = null;
    this.renderInfoPanel();
    this.updateBusMarkers(this.state.lastEnrichedBuses);
  }

  buildInfoChipsHtml(selectedInfoLine) {
    const buses = this.state.lastEnrichedBuses || [];
    const byLine = {};
    buses.forEach(b => {
      if (this.state.lineVisibility[b.lineCode] !== true) return;
      const lc = b.lineCode;
      if (!byLine[lc]) byLine[lc] = { count: 0, color: this.getLegendLineColor(lc), label: b.lineLabel || lc };
      byLine[lc].count++;
    });
    const entries = Object.entries(byLine);
    if (!entries.length) return '';
    const isClassicSkin = this.state.skin.mode === 'classic';
    const chips = entries.map(([lc, { count, color, label }]) => {
      const isSelected = lc === selectedInfoLine;
      const bg = isClassicSkin
        ? color
        : `radial-gradient(120% 120% at 30% 20%, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0) 48%), linear-gradient(150deg, color-mix(in srgb, ${color} 78%, #fff) 0%, ${color} 58%, color-mix(in srgb, ${color} 88%, #000) 100%)`;
      const selectedClass = isSelected ? ' info-chip--selected' : '';
      const busIcon = `<svg class="info-chip-bus-icon" viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M4 16c0 .88.39 1.67 1 2.22V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4S4 2.5 4 6v10zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12v5z"/></svg>`;
      return `<button type="button" class="info-line-chip${selectedClass}" data-info-line="${this.escapeHtmlAttribute(lc)}" style="background:${bg}" aria-pressed="${isSelected}">
      <span class="info-line-chip-code">${this.escapeHtmlAttribute(label)}</span>
      <span class="info-line-chip-count">${busIcon}${count}</span>
    </button>`;
    }).join('');
    return `<div class="info-chips-row">${chips}</div>`;
  }

  buildDeparturesForLine(lineCode) {
    const lc = String(lineCode);
    const collapsed = !!(this.state.departures && this.state.departures.collapsed);
    const btnLabel = collapsed ? 'Apri' : 'Chiudi';
    const icon = collapsed ? '▾' : '▴';
    const bodyStyle = collapsed ? 'display:none;' : '';
    const items = this.getDeparturesItems([lc], null);
    if (!items.length) {
      const hasData = !!(this.state.lastStopDataMap && typeof this.state.lastStopDataMap === 'object');
      if (!hasData) {
        return `<div class="departures-section"><div class="departures-header"><div class="departures-title">Prossime partenze</div></div><div class="departures-body"><div class="departures-empty">In attesa dati…</div></div></div>`;
      }
      return '';
    }
    const body = items.map(it => {
      const badgeColor = this.getLegendLineColor(it.lineCode);
      const times = it.times && it.times.length ? it.times.map(t => this.escapeHtmlAttribute(t)).join(' · ') : '';
      const destLabel = it.destinationLabel ? this.escapeHtmlAttribute(it.destinationLabel) : this.escapeHtmlAttribute(it.destinationKey || '');
      const meta = it.originLabel ? `Da: ${this.escapeHtmlAttribute(it.originLabel)}` : '';
      const runningDot = it.isStarted === true ? `<span class="departures-running-dot" title="Bus in servizio"></span>` : '';
      const right = times
        ? `<div class="departures-times">${runningDot}${times}</div>`
        : `<div class="departures-times departures-times--empty">${this.escapeHtmlAttribute(it.message || 'In attesa dati…')}</div>`;
      return `<div class="departures-line">
      <div class="departures-line-badge" style="background-color:${badgeColor};">${this.escapeHtmlAttribute(it.lineCode)}</div>
      <div class="departures-line-main">
        <div class="departures-dest">${destLabel}</div>
        ${meta ? `<div class="departures-meta">${meta}</div>` : ''}
        ${it.note ? `<div class="departures-note">${this.escapeHtmlAttribute(it.note)}</div>` : ''}
        ${right}
      </div>
    </div>`;
    }).join('');
    return `<div class="departures-section">
    <div class="departures-header">
      <div class="departures-title">Prossime partenze</div>
      <button id="departures-toggle" class="departures-toggle" type="button" aria-label="${btnLabel}" aria-expanded="${collapsed ? 'false' : 'true'}">${icon}</button>
    </div>
    <div class="departures-body" style="${bodyStyle}">${body}</div>
  </div>`;
  }

  renderInfoPanel() {
    if (!this.infoDiv) return;

    const vehicleSelected = !!this.state.selectedVehicleKey && !this.state.selectedVehicleKey.startsWith('TRACK_');
    const selectedInfoLine = this.state.infoPanel.selectedInfoLine;
    const activeLineCodes = Object.keys(this.state.lineVisibility).filter(k => this.state.lineVisibility[k] === true);

    // Build content based on mode
    let combined = '';

    if (vehicleSelected || (this.state.selectedVehicleKey && this.state.selectedVehicleKey.startsWith('TRACK_'))) {
      // MODE 3: vehicle/track selected — existing behavior
      const vehicleHtml = this.buildVehicleInfoHtml();
      const departuresHtml = this.buildDeparturesHtml();
      const busSection = `${vehicleHtml || ''}${vehicleHtml && departuresHtml ? '<div class="info-section-divider"></div>' : ''}${departuresHtml || ''}`;
      combined = busSection;
    } else {
      // MODE 1 or 2: no vehicle selected
      const chipsHtml = this.buildInfoChipsHtml(selectedInfoLine);
      if (!chipsHtml) {
        this.infoDiv.style.display = 'none';
        this.infoDiv.innerHTML = '';
        this.infoDiv.classList.remove('info--departures-only', 'info--departures-collapsed');
        return;
      }
      const departuresHtml = selectedInfoLine ? this.buildDeparturesForLine(selectedInfoLine) : '';
      combined = `<div class="info-header-row">
      <div class="info-section-label">Informazioni</div>
    </div>
    ${chipsHtml}
    ${departuresHtml ? '<div class="info-section-divider"></div>' + departuresHtml : ''}`;
    }

    // Signature check to avoid unnecessary DOM writes
    const vehicleSig = this.getVehicleInfoSignature();
    const fleetSig = (this.state.lastEnrichedBuses || []).filter(b => this.state.lineVisibility[b.lineCode] === true).length;
    const depSig = selectedInfoLine ? `L:${selectedInfoLine}` : (vehicleSelected ? `V:${this.state.selectedVehicleKey}` : '');
    const signature = `${vehicleSig}|${depSig}|${this.state.departures.collapsed ? 1 : 0}|${this.state.infoPanel.collapsed ? 1 : 0}|${activeLineCodes.join(',')}|${this.state.directions.lastKnownSignature || ''}|${this.state.selectedVehicleKey || ''}|${selectedInfoLine || ''}|${this.state.updateStatus.lastSuccessAt || 0}|${fleetSig}`;
    if (signature === this.state.lastInfoSignature) return;
    this.state.lastInfoSignature = signature;

    if (!combined) {
      this.infoDiv.style.display = 'none';
      this.infoDiv.innerHTML = '';
      this.infoDiv.classList.remove('info--departures-only', 'info--departures-collapsed');
      return;
    }

    this.infoDiv.classList.remove('info--departures-only', 'info--departures-collapsed');
    this.infoDiv.innerHTML = combined;
    this.infoDiv.style.display = 'block';
  }

  getVehicleInfoSignature() {
    const track = this.state.infoPanel && this.state.infoPanel.selectedTrack ? this.state.infoPanel.selectedTrack : null;
    if (track) return `T:${track.lineCode}|${track.destination}`;
    if (this.state.infoPanel && this.state.infoPanel.finishedTrip && this.state.selectedVehicleKey && !this.state.selectedVehicleKey.startsWith('TRACK_')) {
      return `F:${this.state.selectedVehicleKey}`;
    }
    const bus = this.state.infoPanel ? this.state.infoPanel.selectedBus : null;
    if (!bus) return '';
    return `B:${bus.key || ''}|${bus.lineCode || ''}|${bus.destination || ''}|${bus.departure || ''}|${bus.race || ''}|${bus.vehicle || ''}|${bus.note || ''}|${bus.arrivalRaw || ''}`;
  }

  getDeparturesSignature(activeLineCodes) {
    if (!Array.isArray(activeLineCodes) || activeLineCodes.length === 0) return '';
    const forced = this.getForcedDeparturesFilter();
    const items = this.getDeparturesItems(forced.lineCodes, forced.forcedDestinationKeyByLine);
    if (!items || items.length === 0) return 'EMPTY';
    return items.map(it => {
      const t = Array.isArray(it.times) && it.times.length ? it.times.join(',') : '';
      return `${it.lineCode}|${it.destinationKey}|${it.originLabel || ''}|${t}|${it.message || ''}|${it.note || ''}|${it.isStarted ? '1' : '0'}`;
    }).join('~');
  }

  getForcedDeparturesFilter() {
    const baseLineCodes = Object.keys(this.state.lineVisibility).filter(k => this.state.lineVisibility[k] === true);
    let lineCodes = baseLineCodes;
    let forcedDestinationKeyByLine = null;
    const selectedBus = this.state.infoPanel ? this.state.infoPanel.selectedBus : null;
    // Only force the filter to a single line when a vehicle is GENUINELY selected.
    // Without this guard a stale selectedBus would pin the panel to one line even
    // after deselection — when nothing is selected we want all active lines shown.
    const vehicleSelected = !!this.state.selectedVehicleKey && !this.state.selectedVehicleKey.startsWith('TRACK_');
    if (vehicleSelected && selectedBus && selectedBus.lineCode) {
      const lc = String(selectedBus.lineCode);
      if (this.state.lineVisibility[lc] === true) {
        lineCodes = [lc];
        const dk = normalizeKey(selectedBus.destination || '');
        if (dk) forcedDestinationKeyByLine = { [lc]: dk };
      }
    } else if (this.state.selectedVehicleKey && this.state.selectedVehicleKey.startsWith('TRACK_')) {
      const track = this.state.infoPanel ? this.state.infoPanel.selectedTrack : null;
      if (track && track.lineCode) {
        const lc = String(track.lineCode);
        if (this.state.lineVisibility[lc] === true) {
          lineCodes = [lc];
          const dk = normalizeKey(track.destination || '');
          if (dk) forcedDestinationKeyByLine = { [lc]: dk };
        }
      }
    }
    return { lineCodes, forcedDestinationKeyByLine };
  }

  buildVehicleInfoHtml() {
    const track = this.state.infoPanel && this.state.infoPanel.selectedTrack ? this.state.infoPanel.selectedTrack : null;
    if (track) {
      return `
        <div class="vehicle-info vehicle-info--glossy" style="--line-color: ${this.getLegendLineColor(track.lineCode)}">
          <div class="info-header" style="border-bottom: none; margin-bottom: 0; padding-bottom: 0;">
            <div class="info-line-badge" style="--line-color: ${this.getLegendLineColor(track.lineCode)}">${this.escapeHtmlAttribute(track.lineLabel)}</div>
            <div class="info-destination">${this.escapeHtmlAttribute(track.destination)}</div>
          </div>
        </div>
      `;
    }

    if (this.state.infoPanel && this.state.infoPanel.finishedTrip && this.state.selectedVehicleKey && !this.state.selectedVehicleKey.startsWith('TRACK_')) {
      return `
        <div class="vehicle-info">
          <div class="info-header" style="border-bottom-color: rgba(220, 53, 69, 0.3)">
            <div class="info-line-badge" style="--line-color: #777">⚠</div>
            <div class="info-destination" style="color: #ff6b6b">Corsa terminata</div>
          </div>
          <div class="info-body">
            <div style="grid-column: 1 / -1; color: #aaa; font-size: 12px; margin-top: 4px;">
              Il veicolo non è più rilevato dal sistema. È probabile che abbia raggiunto il capolinea.
            </div>
          </div>
        </div>
      `;
    }

    // Only show the vehicle card when a vehicle is genuinely selected; a stale
    // selectedBus must not render a highlighted card after deselection.
    const vehicleSelected = !!this.state.selectedVehicleKey && !this.state.selectedVehicleKey.startsWith('TRACK_');
    const bus = (vehicleSelected && this.state.infoPanel) ? this.state.infoPanel.selectedBus : null;
    if (!bus) return '';

    const now = Date.now();
    const lastSuccessAt = this.state.updateStatus.lastSuccessAt || 0;
    const lastErrorAt = this.state.updateStatus.lastErrorAt || 0;
    const lastSelectedMoveAt = this.state.updateStatus.lastSelectedMoveAt || 0;
    const isOffline = lastErrorAt > lastSuccessAt;
    let timeStr = "--:--:--";
    if (lastSuccessAt) {
      const dt = new Date(lastSuccessAt);
      timeStr = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}`;
    }

    const badgeClass = isOffline ? "offline" : "online";
    const ageText = isOffline ? "offline" : `${Math.max(0, Math.floor((now - lastSuccessAt) / 1000))}s fa`;
    const badgeBg = isOffline ? 'rgba(180,60,60,0.2)' : 'rgba(60,180,120,0.15)';
    const badgeBorder = isOffline ? 'rgba(180,60,60,0.4)' : 'rgba(60,180,120,0.4)';
    const lineBadgeColor = bus.lineCode ? this.getLegendLineColor(bus.lineCode) : (bus.lineColor || '#666');
    const lineLabel = bus.lineLabel || (bus.lineCode || '-');

    const collapsed = !!(this.state.infoPanel && this.state.infoPanel.collapsed);
    const collapseBodyStyle = collapsed ? 'display:none;' : '';
    const collapseIcon = collapsed ? '▾' : '▴';
    const collapseLabel = collapsed ? 'Espandi info vettura' : 'Comprimi info vettura';
    const delayBadge = this.getDelayBadge(bus);

    return `
      <div class="vehicle-info vehicle-info--glossy ${collapsed ? 'vehicle-info--collapsed' : ''}" style="--line-color: ${lineBadgeColor}">
        <div class="info-header">
          <div class="info-line-badge" style="--line-color: ${lineBadgeColor}">${this.escapeHtmlAttribute(lineLabel)}</div>
          <div class="info-destination">${this.escapeHtmlAttribute(bus.destination || '-')}</div>
          <button id="vehicle-collapse-toggle" class="vehicle-deselect-btn vehicle-collapse-toggle" type="button" aria-label="${collapseLabel}" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? 'Espandi' : 'Comprimi'}">${collapseIcon}</button>
          <button id="vehicle-deselect-btn" class="vehicle-deselect-btn" type="button" aria-label="Chiudi info vettura" title="Chiudi">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="info-body" style="${collapseBodyStyle}">
          <div class="info-label">Partenza</div><div class="info-value">${this.escapeHtmlAttribute(bus.departure || '-')}</div>
          <div class="info-label">Corsa</div><div class="info-value">${this.escapeHtmlAttribute(bus.race || '-')}</div>
          <div class="info-label">Vettura</div><div class="info-value">${this.escapeHtmlAttribute(bus.vehicle || '-')}</div>
          ${delayBadge ? `<div class="info-label">Ritardo</div><div class="info-value"><span style="padding: 2px 8px; border-radius: 10px; background: ${delayBadge.bg}; border: 1px solid ${delayBadge.border}; color: ${delayBadge.color}; font-weight: 700; font-size: 12px;">${this.escapeHtmlAttribute(delayBadge.text)}</span></div>` : ''}
          ${bus.note ? `<div class="info-label info-note-label">Nota</div><div class="info-value info-note-value">${this.escapeHtmlAttribute(bus.note)}</div>` : ''}
        </div>
        <div class="info-footer" style="${collapseBodyStyle}">
          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
            <span id="info-update-badge" class="${badgeClass}" style="padding: 2px 8px; border-radius: 10px; background: ${badgeBg}; border: 1px solid ${badgeBorder}">
              Aggiornato ${this.escapeHtmlAttribute(ageText)}
            </span>
            <span style="color: #888;">${this.escapeHtmlAttribute(timeStr)}</span>
          </div>
        </div>
      </div>
    `;
  }

  buildDeparturesHtml() {
    const baseActiveLineCodes = Object.keys(this.state.lineVisibility).filter(k => this.state.lineVisibility[k] === true);
    if (baseActiveLineCodes.length === 0) return '';

    const forced = this.getForcedDeparturesFilter();
    const { lineCodes: activeLineCodes, forcedDestinationKeyByLine } = forced;

    const collapsed = !!(this.state.departures && this.state.departures.collapsed);
    const btnLabel = collapsed ? 'Apri' : 'Chiudi';
    const icon = collapsed ? '▾' : '▴';
    const bodyStyle = collapsed ? 'display:none;' : '';

    const items = this.getDeparturesItems(activeLineCodes, forcedDestinationKeyByLine);
    let body = '';

    if (items.length === 0) {
      // Only show "waiting for data" while data has genuinely not loaded yet.
      // Once data is present, hide the section entirely — the selected lines are
      // still represented by the fleet chips, so we never show a stale placeholder.
      const hasData = !!(this.state.lastStopDataMap && typeof this.state.lastStopDataMap === 'object');
      if (!hasData) {
        body = `<div class="departures-empty">In attesa dati…</div>`;
      } else {
        return '';
      }
    } else {
      body = items.map(it => {
        const badgeColor = this.getLegendLineColor(it.lineCode);
        const times = it.times && it.times.length ? it.times.map(t => this.escapeHtmlAttribute(t)).join(' · ') : '';
        const destLabel = it.destinationLabel ? this.escapeHtmlAttribute(it.destinationLabel) : this.escapeHtmlAttribute(it.destinationKey || '');

        const meta = it.originLabel ? `Da: ${this.escapeHtmlAttribute(it.originLabel)}` : '';
        const runningDot = it.isStarted === true ? `<span class="departures-running-dot" title="Bus in servizio"></span>` : '';
        const right = times
          ? `<div class="departures-times">${runningDot}${times}</div>`
          : `<div class="departures-times departures-times--empty">${this.escapeHtmlAttribute(it.message || 'In attesa dati…')}</div>`;

        return `
          <div class="departures-line">
            <div class="departures-line-badge" style="background-color:${badgeColor};">${this.escapeHtmlAttribute(it.lineCode)}</div>
            <div class="departures-line-main">
              <div class="departures-dest">${destLabel}</div>
              ${meta ? `<div class="departures-meta">${meta}</div>` : ''}
              ${it.note ? `<div class="departures-note">${this.escapeHtmlAttribute(it.note)}</div>` : ''}
              ${right}
            </div>
          </div>
        `;
      }).join('');
    }

    const isFiltered = activeLineCodes.length === 1 && activeLineCodes.length < baseActiveLineCodes.length;
    const filteredLine = isFiltered ? activeLineCodes[0] : null;
    const filterBadge = filteredLine
      ? `<button id="departures-deselect-btn" class="departures-filter-badge" type="button" title="Mostra tutte le linee" aria-label="Rimuovi filtro linea ${filteredLine}">
           <span class="departures-filter-badge-code" style="background:${this.getLegendLineColor(filteredLine)}">${this.escapeHtmlAttribute(filteredLine)}</span>
           <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
         </button>`
      : '';

    return `
      <div class="departures-section">
        <div class="departures-header">
          <div class="departures-title">Prossime partenze</div>
          ${filterBadge}
          <button id="departures-toggle" class="departures-toggle" type="button" aria-label="${btnLabel}" aria-expanded="${collapsed ? 'false' : 'true'}">${icon}</button>
        </div>
        <div class="departures-body" style="${bodyStyle}">
          ${body}
        </div>
      </div>
    `;
  }

  getDeparturesItems(activeLineCodes, forcedDestinationKeyByLine = null) {
    const stopDataMap = this.state.lastStopDataMap && typeof this.state.lastStopDataMap === 'object' ? this.state.lastStopDataMap : null;
    const directions = this.state.directions || {};
    const knownByLine = directions.knownByLine && typeof directions.knownByLine === 'object' ? directions.knownByLine : {};
    const filterByLine = directions.filterByLine && typeof directions.filterByLine === 'object' ? directions.filterByLine : {};
    const defaultFilterByLine = directions.defaultFilterByLine && typeof directions.defaultFilterByLine === 'object' ? directions.defaultFilterByLine : {};
    const overrideModeByLine = directions.overrideModeByLine && typeof directions.overrideModeByLine === 'object' ? directions.overrideModeByLine : {};

    const out = [];

    activeLineCodes.forEach(lineCode => {
      const lc = String(lineCode);
      const lineConf = Array.isArray(linesConfig) ? linesConfig.find(l => l && l.code === lc) : null;
      const stops = lineConf && Array.isArray(lineConf.stops) ? lineConf.stops : [];
      const stopA = stops.length ? String(stops[0]) : null;
      const stopB = stops.length ? String(stops[stops.length - 1]) : null;
      const forcedKeyForLine = forcedDestinationKeyByLine && forcedDestinationKeyByLine[lc] ? String(forcedDestinationKeyByLine[lc]) : '';

      const known = knownByLine[lc] && typeof knownByLine[lc] === 'object' ? knownByLine[lc] : {};
      const knownKeys = Object.keys(known);

      const mode = overrideModeByLine[lc];
      const userSet = filterByLine[lc] instanceof Set ? filterByLine[lc] : null;
      const defaultSet = defaultFilterByLine[lc] instanceof Set ? defaultFilterByLine[lc] : null;

      const availableKeysFromStopData = new Set();
      if (stopDataMap && stops.length > 0) {
        stops.forEach(sCode => {
          const runs = stopDataMap[sCode];
          if (!Array.isArray(runs)) return;
          runs.forEach(r => {
            if (String((r.LineCode || '')).toUpperCase() !== lc) return;
            const dk = normalizeKey(String(r.Destination || '').trim());
            if (dk) availableKeysFromStopData.add(dk);
          });
        });
      }

      let destKeys = [];
      if (forcedKeyForLine) {
        destKeys = [forcedKeyForLine];
      } else
      if (mode === 'set' && userSet instanceof Set && userSet.size > 0) {
        const base = Array.from(userSet);
        if (availableKeysFromStopData.size > 0) destKeys = base.filter(k => availableKeysFromStopData.has(String(k)));
        else destKeys = base;
      } else if (defaultSet instanceof Set && defaultSet.size > 0) {
        const base = Array.from(defaultSet);
        if (availableKeysFromStopData.size > 0) destKeys = base.filter(k => availableKeysFromStopData.has(String(k)));
        else destKeys = base;
      } else if (knownKeys.length > 0) {
        destKeys = knownKeys;
      } else if (availableKeysFromStopData.size > 0) {
        destKeys = Array.from(availableKeysFromStopData);
      }

      if (destKeys.length === 0) {
        if (forcedKeyForLine) {
          out.push({
            lineCode: lc,
            destinationKey: '',
            destinationLabel: '',
            originLabel: '',
            times: [],
            message: 'Nessun dato disponibile'
          });
        }
        return;
      }

      destKeys.forEach(destKey => {
        const dk = String(destKey);
        const destLabel = String(known[dk] || dk);

        let originStop = stopA;
        if (stopDataMap && stopA && stopB && stopA !== stopB) {
          const aHas = Array.isArray(stopDataMap[stopA]) && stopDataMap[stopA].some(r => String((r.LineCode || '')).toUpperCase() === lc && normalizeKey(r.Destination) === dk);
          const bHas = Array.isArray(stopDataMap[stopB]) && stopDataMap[stopB].some(r => String((r.LineCode || '')).toUpperCase() === lc && normalizeKey(r.Destination) === dk);
          if (aHas && !bHas) originStop = stopA;
          else if (!aHas && bHas) originStop = stopB;
          else originStop = stopA;
        }

        let originLabel = '';
        let times = [];
        let message = '';
        let note = '';
        let isStarted = null;
        if (!stopDataMap || !originStop || !Array.isArray(stopDataMap[originStop])) {
          if (!forcedKeyForLine) return;
          message = 'In attesa dati…';
        } else {
          const runs = stopDataMap[originStop].filter(r => String((r.LineCode || '')).toUpperCase() === lc && normalizeKey(r.Destination) === dk);
          const bestWithNext = runs.find(r => String(r.NextPasses || '').trim()) || null;
          const best = bestWithNext || (forcedKeyForLine ? (runs[0] || null) : null);
          if (!best) {
            if (!forcedKeyForLine) return;
            message = 'Nessun dato disponibile';
          } else {
            originLabel = String(best.Departure || '').trim();
            note = String(best.Note || '').trim();
            isStarted = best.IsStarted !== false;
            const raw = String(best.NextPasses || '').trim();
            if (raw) {
              times = raw.split('-').map(x => x.trim()).filter(Boolean).slice(0, 8);
            } else {
              if (!forcedKeyForLine) return;
              message = 'Nessuna corsa imminente';
            }
          }
        }

        out.push({
          lineCode: lc,
          destinationKey: dk,
          destinationLabel: destLabel,
          originLabel,
          times,
          message,
          note,
          isStarted
        });
      });
    });

    out.sort((a, b) => {
      const la = a.lineCode.localeCompare(b.lineCode, undefined, { numeric: true, sensitivity: 'base' });
      if (la !== 0) return la;
      return String(a.destinationLabel || a.destinationKey || '').localeCompare(String(b.destinationLabel || b.destinationKey || ''), undefined, { sensitivity: 'base' });
    });

    return out;
  }

  getBusIconZoomScale(zoom) {
    const z = typeof zoom === 'number' ? zoom : CONFIG.MAP.DEFAULT_ZOOM;
    const base = CONFIG.MAP.DEFAULT_ZOOM;
    const max = 19;
    const tRaw = (z - base) / (max - base);
    const t = Math.max(0, Math.min(1, tRaw));
    const eased = 1 - Math.pow(1 - t, 3);
    const minScale = 0.64;
    const maxScale = Math.max(minScale, Number(CONFIG.UI.BUS_ICON_SCALE_MAX) || 1.0);
    return minScale + (maxScale - minScale) * eased;
  }

  shouldShowBusLabel(zoom) {
    const z = typeof zoom === 'number' ? zoom : CONFIG.MAP.DEFAULT_ZOOM;
    return z >= (CONFIG.MAP.DEFAULT_ZOOM + 1);
  }

  // Heading dedotto dalla geometria del tracciato già scaricato per quella
  // linea+destinazione: proietta la vettura sul vertice più vicino della polyline
  // e restituisce la direzione del segmento VERSO la fine (il capolinea di
  // destinazione). Null se il tracciato non è ancora disponibile.
  computeTrackHeading(lineCode, destination, lat, lon) {
    const layer = this.state.routeLayers[`${lineCode}_${normalizeKey(destination)}`];
    if (!layer || typeof layer.getLatLngs !== 'function') return null;
    const pts = layer.getLatLngs();
    if (!Array.isArray(pts) || pts.length < 2) return null;

    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dLat = pts[i].lat - lat;
      const dLon = pts[i].lng - lon;
      const d = dLat * dLat + dLon * dLon;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    const a = bestI < pts.length - 1 ? pts[bestI] : pts[bestI - 1];
    const c = bestI < pts.length - 1 ? pts[bestI + 1] : pts[bestI];
    return this.computeBearing(a.lat, a.lng, c.lat, c.lng);
  }

  // Quando un tracciato arriva (async, dopo il primo render), riorienta le
  // vetture apparse prima che fosse pronto e che non si sono ancora mosse.
  reorientStationaryBuses() {
    const buses = this.state.lastEnrichedBuses;
    if (!Array.isArray(buses) || buses.length === 0) return;
    let changed = false;
    buses.forEach(b => {
      const st = this.state.vehicleState[b.key];
      if (!st || st.headingFromMove) return;
      const t = this.computeTrackHeading(b.lineCode, b.destination, b.coords[0], b.coords[1]);
      if (t == null || t === st.heading) return;
      st.heading = t;
      b.heading = t;
      changed = true;
    });
    if (changed) this.updateBusMarkers(buses);
  }

  // Ritardo = (adesso + minuti dal countdown live "ArrivalTime") - orario
  // pianificato ("Time"). Il countdown ("N min") compare solo per corse già
  // tracciate via GPS; per le altre l'API ripete l'orario pianificato come
  // etichetta ("HH:MM"), quindi la regex non combacia e non mostriamo nulla
  // (niente ritardo inventato per corse non ancora partite).
  computeDelayMinutes(bus) {
    if (!bus || !bus.arrivalRaw || !bus.scheduledTime) return null;
    const m = /^(\d+)\s*min/i.exec(bus.arrivalRaw.trim());
    if (!m) return null;
    const scheduled = new Date(bus.scheduledTime).getTime();
    if (Number.isNaN(scheduled)) return null;
    const predicted = Date.now() + parseInt(m[1], 10) * 60000;
    return Math.round((predicted - scheduled) / 60000);
  }

  getDelayBadge(bus) {
    const delay = this.computeDelayMinutes(bus);
    if (delay === null) return null;
    if (delay <= 2) {
      return { text: 'In orario', bg: 'rgba(60,180,120,0.15)', border: 'rgba(60,180,120,0.4)', color: 'var(--ok)' };
    }
    if (delay <= 7) {
      return { text: `+${delay} min`, bg: 'rgba(249,171,0,0.15)', border: 'rgba(249,171,0,0.4)', color: 'var(--fav)' };
    }
    return { text: `+${delay} min`, bg: 'rgba(217,48,37,0.15)', border: 'rgba(217,48,37,0.4)', color: 'var(--danger)' };
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
