// Initial configuration
const linesConfig = window.linesConfig || [];

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

class BusMagoApp {
  constructor() {
    this.state = {
      busMarkers: {}, // key -> L.marker
      vehicleState: {}, // key -> { lat, lon, heading }
      selectedVehicleKey: null,
      directionVisibility: {},
      lastEnrichedBuses: [],
      routeLayers: {}, // key -> L.polyline
      routeEndpointMarkers: {}, // key -> array of markers
      lastRaces: {},
      trackRefreshCounters: {},
      userHasInteracted: false,
      isFollowing: false,
      map: null,
      easterEgg: {
        active: false,
        marker: null,
        interval: null,
        index: 0
      },
      stopCache: {
        ttlMs: 5000,
        entries: {},
        inFlight: {}
      },
      lastInfoSignature: null,
      favorites: {
        key: 'busmago:favorites:v1',
        set: new Set(),
        snapshot: null
      },
      theme: {
        key: 'busmago:theme:v1',
        mode: 'dark'
      },
      legend: {
        filterText: ''
      },
      persisted: {
        activeLinesKey: 'busmago:activeLines:v1'
      },
      updateStatus: {
        lastSuccessAt: 0,
        lastErrorAt: 0,
        lastErrorMessage: '',
        lastSelectedMoveAt: 0
      },
      uiTimers: {
        infoAgeInterval: null,
        refreshTimeout: null
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

  init() {
    this.loadTheme();
    this.loadFavorites();
    this.initMap();
    this.initToast();
    this.initVisibility();
    this.loadActiveLines();
    this.renderLegend();
    this.setupEvents();
    this.initUserLocation();

    // Start loop
    this.scheduleNextRefresh(0);

    this.state.uiTimers.infoAgeInterval = setInterval(() => {
      if (!this.state.selectedVehicleKey) return;
      this.updateInfoAgeBadge();
    }, 1000);
  }

  initMap() {
    this.state.map = L.map('map', { zoomControl: false }).setView([45.653, 13.776], 14);
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
  }

  loadFavorites() {
    try {
      const raw = localStorage.getItem(this.state.favorites.key);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) this.state.favorites.set = new Set(arr.filter(x => typeof x === 'string'));
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
      const active = Object.keys(this.state.directionVisibility).filter(k => this.state.directionVisibility[k] === true);
      localStorage.setItem(this.state.persisted.activeLinesKey, JSON.stringify(active));
    } catch {
    }
  }

  loadActiveLines() {
    try {
      const raw = localStorage.getItem(this.state.persisted.activeLinesKey);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      const set = new Set(arr.filter(x => typeof x === 'string'));
      Object.keys(this.state.directionVisibility).forEach(k => {
        this.state.directionVisibility[k] = set.has(k);
      });
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

    const p = fetch(`https://realtime.tplfvg.it/API/v1.0/polemonitor/mrcruns?StopCode=${stopCode}&IsUrban=true`)
      .then(r => r.json())
      .then(data => {
        const normalized = Array.isArray(data) ? data : [];
        this.state.stopCache.entries[stopCode] = { data: normalized, expiresAt: now + this.state.stopCache.ttlMs };
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
    // Hide after 3 seconds
    setTimeout(() => {
        if (this.toastDiv) this.toastDiv.classList.remove('show');
    }, 3000);
  }

  initVisibility() {
    linesConfig.forEach(l => {
      l.directions.forEach(d => {
        const key = `${l.label} - ${d}`;
        this.state.directionVisibility[key] = false;
      });
    });
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
    
    // Map interaction
    map.on('zoomstart', () => this.handleInteraction());
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
        menuToggle.addEventListener('click', () => {
            this.legendDiv.style.display = (this.legendDiv.style.display === 'none') ? 'block' : 'none';
        });
    }
  }

  handleInteraction() {
    this.state.userHasInteracted = true;
    if (this.legendDiv.style.display === 'block') {
      this.legendDiv.style.display = 'none';
    }
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
              html: '<div style="background-color: #ffffff; width: 15px; height: 15px; border-radius: 50%; border: 2px solid #000; box-shadow: 0 0 5px rgba(255,255,255,0.8);"></div>',
              iconSize: [20, 20],
              iconAnchor: [10, 10]
            })
          }).addTo(this.state.map).bindPopup("Areo qua! 📍");
          
          userAccuracyCircle = L.circle([lat, lon], {
            color: '#ffffff',
            fillColor: '#ffffff',
            fillOpacity: 0.15,
            radius: accuracy,
            weight: 1
          }).addTo(this.state.map);
        }
        
        if (firstLocationUpdate) {
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
    let html = "";
    
    const filterValue = (this.state.legend.filterText || '').trim();
    html += `<div style="margin: 8px 0 10px 0;">
              <input id="legend-search" type="text" placeholder="Cerca linea..." value="${filterValue.replace(/"/g, '&quot;')}" style="width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid #666; background: rgba(0,0,0,0.15); color: inherit;">
            </div>`;

    html += `<label style="display:block; margin-bottom:8px; border-bottom:1px solid #666; padding-bottom:4px; cursor:pointer;">
              <input type="checkbox" id="favorites-toggle" style="margin-right:5px;">
              <strong>Preferiti</strong>
            </label>`;

    // Presets
    html += `<label style="display:block; margin-bottom:4px; cursor:pointer;">
              <input type="checkbox" id="preset-universita" style="margin-right:5px;">
              <strong>Università</strong>
            </label>`;
    html += `<label style="display:block; margin-bottom:4px; cursor:pointer;">
              <input type="checkbox" id="preset-stazione" style="margin-right:5px;">
              <strong>Stazione</strong>
            </label>`;
    html += `<label style="display:block; margin-bottom:8px; border-bottom:1px solid #666; padding-bottom:4px; cursor:pointer;">
              <input type="checkbox" id="preset-notturne" style="margin-right:5px;">
              <strong>Notturne (A-D)</strong>
            </label>`;
  
    const favoritesOnly = this.legendDiv.dataset.favoritesOnly === '1';
    const filterText = (this.state.legend.filterText || '').trim().toLowerCase();

    // Clear All Button (moved to top)
    html += `<button id="clear-all-lines" style="width:100%; margin-bottom:10px; padding:8px; background-color:#e0e0e0; color:#333; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">
              CLEAR ALL
            </button>`;

    // Lines
    let separatorAdded = false;
    linesConfig.forEach(l => {
      // Add separator before night lines
      if (!separatorAdded && ["A", "B", "C", "D"].includes(l.code)) {
        html += '<hr style="margin: 8px 0; border: 0; border-top: 1px solid #666;">';
        separatorAdded = true;
      }
      
      // Add separator before 777
      if (l.code === "777") {
          html += '<hr style="margin: 8px 0; border: 0; border-top: 1px solid #666;">';
      }

      l.directions.forEach(d => {
        const key = `${l.label} - ${d}`;
        
        // Ensure 777 Bateo Gambling is in directionVisibility
        if (l.code === "777" && !this.state.directionVisibility.hasOwnProperty(key)) {
            this.state.directionVisibility[key] = false;
        }
        
        if (this.state.directionVisibility.hasOwnProperty(key)) {
          const isFavorite = this.state.favorites.set.has(key);
          if (favoritesOnly && !isFavorite) return;
          if (filterText) {
            const hay = `${l.code} ${l.label} ${d} ${key}`.toLowerCase();
            if (!hay.includes(filterText)) return;
          }

          const checked = this.state.directionVisibility[key] ? "checked" : "";
          const safeKey = key.replace(/"/g, '&quot;');
          const colorBox = `<span style="display:inline-block;width:10px;height:10px;background-color:${l.color};margin-right:5px;border-radius:50%;"></span>`;
          const activeClass = this.state.directionVisibility[key] ? 'active-line' : '';
          const favSymbol = isFavorite ? '★' : '☆';
          html += `<label class="legend-line ${activeClass}" style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:4px; cursor:pointer;">
                    <span style="display:flex; align-items:center; gap:6px;">
                      <input type="checkbox" data-key="${safeKey}" ${checked} style="margin-right:5px;">
                      ${colorBox}${key}
                    </span>
                    <button type="button" class="fav-btn" data-fav="${safeKey}" style="background:transparent; border:0; color:inherit; cursor:pointer; font-size:14px; padding:2px 6px;">${favSymbol}</button>
                  </label>`;
        }
      });
    });
  
    // "Select All" (Moved to bottom)
    const allSelected = Object.keys(this.state.directionVisibility)
        .filter(k => !k.includes("777 Bateo Gambling"))
        .every(k => this.state.directionVisibility[k]);

    html += `<label style="display:block; margin-top:8px; border-top:1px solid #666; padding-top:4px; cursor:pointer;">
              <input type="checkbox" id="select-all-lines" ${allSelected ? 'checked' : ''} style="margin-right:5px;">
              <strong>Seleziona tutto</strong>
            </label>`;

    this.legendDiv.innerHTML = html;
    
    // Add Listeners
    this.setupLegendListeners();
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

    const favoritesToggle = document.getElementById('favorites-toggle');
    if (favoritesToggle) {
      favoritesToggle.checked = this.legendDiv.dataset.favoritesOnly === '1';
      favoritesToggle.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        this.legendDiv.dataset.favoritesOnly = enabled ? '1' : '0';

        if (enabled) {
          this.state.favorites.snapshot = { ...this.state.directionVisibility };
          Object.keys(this.state.directionVisibility).forEach(k => {
            this.state.directionVisibility[k] = this.state.favorites.set.has(k);
          });
          this.updateBusMarkers(this.state.lastEnrichedBuses);
          this.updateTrackStyles();
          this.saveActiveLines();
        } else {
          if (this.state.favorites.snapshot) {
            this.state.directionVisibility = { ...this.state.favorites.snapshot };
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
            Object.keys(this.state.directionVisibility).forEach(k => {
                if (!k.includes("777 Bateo Gambling")) {
                    this.state.directionVisibility[k] = false;
                }
            });
            this.updateBusMarkers(this.state.lastEnrichedBuses);
            this.saveActiveLines();
            this.renderLegend();
        });
    }

    // Select All
    const selectAllCheckbox = document.getElementById('select-all-lines');
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const checkboxes = this.legendDiv.querySelectorAll('input[type="checkbox"][data-key]');
        
        checkboxes.forEach(cb => {
          const k = cb.getAttribute('data-key');
          if (k.includes("777 Bateo Gambling")) return; // Skip 777

          cb.checked = isChecked;
          this.state.directionVisibility[k] = isChecked;
        });
        
        this.updateBusMarkers(this.state.lastEnrichedBuses);
        this.saveActiveLines();
      });
    }

    // Presets helper
    const handlePreset = (id, targets) => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.addEventListener('change', (e) => {
                const isChecked = e.target.checked;
                targets.forEach(k => {
                    this.state.directionVisibility[k] = isChecked;
                    const cb = this.legendDiv.querySelector(`input[type="checkbox"][data-key="${k.replace(/"/g, '&quot;')}"]`);
                    if (cb) cb.checked = isChecked;
                });
                this.updateBusMarkers(this.state.lastEnrichedBuses);
                this.saveActiveLines();
            });
        }
    };

    // Università Preset
    handlePreset('preset-universita', [
        "17 - SAN CILINO", "17/ - SAN CILINO", "4 - VILLA CARSIA",
        "51 - STAZIONE FERROVIARIA", "51 - VILLA CARSIA", "51/ - STAZIONE FERROVIARIA"
    ]);

    // Stazione Preset
    handlePreset('preset-stazione', [
        "17/ - STAZIONE FERROVIARIA", "17 - VIA DI CAMPO MARZIO", "4 - PIAZZA OBERDAN",
        "51 - STAZIONE FERROVIARIA", "51 - VILLA CARSIA", "51/ - STAZIONE FERROVIARIA"
    ]);

    // Notturne Preset (A, B, C, D)
    const nightLines = [];
    linesConfig.forEach(l => {
        if (["A", "B", "C", "D"].includes(l.code)) {
            l.directions.forEach(d => nightLines.push(`${l.label} - ${d}`));
        }
    });
    handlePreset('preset-notturne', nightLines);

    // Individual checkboxes
    const individualCheckboxes = this.legendDiv.querySelectorAll('input[type="checkbox"][data-key]');
    individualCheckboxes.forEach(input => {
      input.addEventListener('change', (e) => {
        const k = e.target.getAttribute('data-key');
        this.state.directionVisibility[k] = e.target.checked;
        
        // Update Select All state (ignoring 777)
        if (selectAllCheckbox) {
            const allOtherChecked = Array.from(individualCheckboxes)
                .filter(cb => !cb.getAttribute('data-key').includes("777 Bateo Gambling"))
                .every(cb => cb.checked);
            selectAllCheckbox.checked = allOtherChecked;
        }

        this.updateBusMarkers(this.state.lastEnrichedBuses);
        this.saveActiveLines();
      });
    });
  }

  getRefreshIntervalMs() {
    const isFollowingSelected = !!(this.state.selectedVehicleKey && !this.state.selectedVehicleKey.startsWith('TRACK_') && this.state.isFollowing);
    if (isFollowingSelected) return 2000;

    let activeDirectionCount = 0;
    linesConfig.forEach(l => {
      l.directions.forEach(d => {
        const key = `${l.label} - ${d}`;
        if (this.state.directionVisibility[key] === true) activeDirectionCount++;
      });
    });

    if (!this.state.selectedVehicleKey || activeDirectionCount > 10) return 5000;
    return 3000;
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
        // 1. Count active directions to determine optimization level
        let activeDirectionCount = 0;
        linesConfig.forEach(l => {
            l.directions.forEach(d => {
                const key = `${l.label} - ${d}`;
                if (this.state.directionVisibility[key] === true) {
                    activeDirectionCount++;
                }
            });
        });
        
        // Optimization Logic
        // <= 5 directions: All stops
        // > 5 directions: Terminals + 1 intermediate (approx 3 stops total per line)
        // > 10 directions: Terminals only (approx 2 stops total per line)
        
        let stopsLimitPerLine = Infinity;
        if (activeDirectionCount > 10) {
            stopsLimitPerLine = 2; // Usually just terminals
        } else if (activeDirectionCount > 5) {
            stopsLimitPerLine = 3; // Terminals + 1 intermediate
        }

        const uniqueStops = new Set();
        let hasActiveLines = false;

        linesConfig.forEach(l => {
            // Check if any direction of this line is active
            const isLineActive = l.directions.some(d => {
                const key = `${l.label} - ${d}`;
                return this.state.directionVisibility[key] === true;
            });

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
                    stopsToUse = l.stops.slice(0, stopsLimitPerLine);
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
                                lineColor: lineConf.color,
                                lineCode: lineConf.code
                            });
                        }
                    }
                });
            });
        });

        // 4. Process Tracks
        this.processTracks(stopDataMap);

        // 5. Deduplicate and Enrich
        const byVehicle = {};
        buses.forEach(b => {
            const k = b.vehicle || `NO_VEHICLE_${b.coords[0]}_${b.coords[1]}`;
            byVehicle[k] = b;
        });
        const uniqueBuses = Object.values(byVehicle);

        const enriched = uniqueBuses.map(b => {
            const key = b.vehicle || `NO_VEHICLE_${b.coords[0]}_${b.coords[1]}`;
            const prev = this.state.vehicleState[key];
            let heading = (prev && typeof prev.heading === 'number') ? prev.heading : 0;
            const moved = !prev || prev.lat !== b.coords[0] || prev.lon !== b.coords[1];
            
            if (prev && moved) {
                heading = this.computeBearing(prev.lat, prev.lon, b.coords[0], b.coords[1]);
            }
            
            this.state.vehicleState[key] = { lat: b.coords[0], lon: b.coords[1], heading: heading, moved: moved };
            b.heading = heading;
            b.key = key;
            b.moved = moved;
            return b;
        });

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
    linesConfig.forEach(lineConf => {
        // Collect all active runs
        const allRuns = [];
        lineConf.stops.forEach(sCode => {
            const runs = stopDataMap[sCode];
            if (Array.isArray(runs)) {
                runs.forEach(r => {
                    if ((r.LineCode || "").toUpperCase() === lineConf.code) {
                        allRuns.push(r);
                    }
                });
            }
        });

        lineConf.directions.forEach(dir => {
            const targetDest = dir.toUpperCase();
            
            // Easter Egg 777
            if (lineConf.code === "777" && dir === "CASINÒ VENEZIA") {
                this.handleEasterEggTrack(lineConf, dir);
                return;
            }

            // Find best run
            let bestRun = null;
            for (const r of allRuns) {
                if ((r.Destination || "").toUpperCase() === targetDest && r.Race) {
                    bestRun = r;
                    break;
                }
            }

            if (bestRun) {
                const race = String(bestRun.Race);
                const legendKey = `${lineConf.label} - ${dir}`;
                const trackKey = `${lineConf.code}_${dir}`;

                // Optimization: If track already exists, do NOT update it.
                // Tracks are static enough during a short session.
                if (this.state.routeLayers[trackKey]) {
                    return; 
                }

                if (!this.state.trackRefreshCounters[trackKey]) this.state.trackRefreshCounters[trackKey] = 0;
                if (!this.state.lastRaces[trackKey]) this.state.lastRaces[trackKey] = "";

                if (race && (race !== this.state.lastRaces[trackKey] || this.state.trackRefreshCounters[trackKey] >= 6)) {
                    this.state.lastRaces[trackKey] = race;
                    this.state.trackRefreshCounters[trackKey] = 0;

                    const lineCodeForTrack = bestRun.Line || ("T" + (lineConf.code.length === 1 ? "0" + lineConf.code : lineConf.code));
                    const url = `https://realtime.tplfvg.it/API/v1.0/polemonitor/LineGeoTrack?Line=${encodeURIComponent(lineCodeForTrack)}&Race=${encodeURIComponent(race)}`;

                    fetch(url)
                        .then(r => r.json())
                        .then(track => {
                            if (Array.isArray(track)) {
                                this.updateTrackLayer(trackKey, legendKey, lineConf, dir, track);
                            }
                        })
                        .catch(err => console.error(`Errore caricamento tracciato ${trackKey}`, err));
                } else {
                    this.state.trackRefreshCounters[trackKey] += 1;
                }
            }
        });
    });
  }

  handleEasterEggTrack(lineConf, dir) {
      const trackKey = "777_CASINÒ VENEZIA";
      const legendKey = `${lineConf.label} - ${dir}`;
      
      if (!this.state.routeLayers[trackKey]) {
          const pts = easterEggTrack777;
          const polyline = L.polyline(pts, { 
              color: lineConf.color, 
              weight: 3.5, 
              dashArray: '10, 10' 
          }).addTo(this.state.map);
          
          this.state.routeLayers[trackKey] = polyline;
          polyline.options.legendKey = legendKey;

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

  updateTrackLayer(trackKey, legendKey, lineConf, dir, trackData) {
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
      } else {
          const polyline = L.polyline(pts, { color: lineConf.color, weight: 3.5 }).addTo(this.state.map);
          this.state.routeLayers[trackKey] = polyline;
          polyline.options.legendKey = legendKey;

          polyline.on('click', (e) => {
              L.DomEvent.stopPropagation(e);
              this.state.selectedVehicleKey = "TRACK_" + trackKey;
              this.updateInfoFromTrack(lineConf, dir);
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
          endpoints.push(L.circleMarker(start, { radius: 3.5, color: lineConf.color, fillColor: lineConf.color, fillOpacity: 1 }).addTo(this.state.map));
          endpoints.push(L.circleMarker(end, { radius: 3.5, color: lineConf.color, fillColor: lineConf.color, fillOpacity: 1 }).addTo(this.state.map));
      }
      this.state.routeEndpointMarkers[trackKey] = endpoints;
      
      this.updateTrackStyles();
  }

  updateBusMarkers(buses) {
    this.state.lastEnrichedBuses = buses || [];
    const newKeys = new Set();
    
    // Calculate active line count for icon sizing
    let activeLineCount = 0;
    linesConfig.forEach(l => {
        const isActive = l.directions.some(d => this.state.directionVisibility[`${l.label} - ${d}`]);
        if (isActive) activeLineCount++;
    });
    const useSmallIcons = activeLineCount >= 10;
    const iconSize = useSmallIcons ? [28, 28] : [40, 40];
    const iconAnchor = useSmallIcons ? [14, 14] : [20, 20];
    const sizeClass = useSmallIcons ? 'small' : 'large';

    if (buses && buses.length > 0) {
      buses.forEach(b => {
        const legendKey = `${b.lineLabel} - ${b.destination}`;
        if (this.state.directionVisibility[legendKey] !== true) return;

        newKeys.add(b.key);
        
        let isSelected = false;
        if (this.state.selectedVehicleKey) {
            if (this.state.selectedVehicleKey.startsWith("TRACK_")) {
                const trackKey = this.state.selectedVehicleKey.substring(6);
                const busTrackKey = `${b.lineCode}_${b.destination}`;
                if (trackKey === busTrackKey) isSelected = true;
            } else if (b.key === this.state.selectedVehicleKey) {
                isSelected = true;
            }
        }

        const opacity = (this.state.selectedVehicleKey && !isSelected) ? 0.3 : 1.0;
        const heading = typeof b.heading === 'number' ? b.heading : 0;
        const borderStyle = isSelected ? 'border: 3px solid #FFF;' : '';
        const opacityStyle = `opacity: ${opacity};`;
        const iconHtml = `<div class="bus-icon ${sizeClass}" style="background-color: ${b.lineColor}; transform: rotate(${heading + 135}deg); ${borderStyle} ${opacityStyle}"><span style="display:inline-block; transform: rotate(${-(heading + 135)}deg);">${b.lineLabel}</span></div>`;

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
                        iconDiv.style.backgroundColor = b.lineColor;
                        iconDiv.style.transform = `rotate(${heading + 135}deg)`;
                        iconDiv.style.opacity = (this.state.selectedVehicleKey && !isSelected) ? 0.35 : 1.0;
                        iconDiv.style.border = isSelected ? '3px solid #FFF' : '';
                        
                        // Update text content (only if changed)
                        const span = iconDiv.querySelector('span');
                        if (span) {
                            if (span.textContent !== b.lineLabel) span.textContent = b.lineLabel;
                            span.style.transform = `rotate(${-(heading + 135)}deg)`;
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
                    targetTrackKey = `${selectedBus.lineCode}_${selectedBus.destination}`;
                }
            }
        }
    }

    Object.keys(this.state.routeLayers).forEach(tKey => {
        const layer = this.state.routeLayers[tKey];
        const endpoints = this.state.routeEndpointMarkers[tKey];
        if (!layer) return;

        const legendKey = layer.options.legendKey;
        const isVisibleInLegend = this.state.directionVisibility[legendKey] === true;

        if (!isVisibleInLegend) {
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

        layer.setStyle({ opacity: opacity, weight: 3 });
        if (endpoints) {
            endpoints.forEach(e => {
                if (e.setStyle) e.setStyle({ opacity: opacity, fillOpacity: opacity });
                else if (e.setOpacity) e.setOpacity(opacity);
            });
        }
    });

    this.updateEasterEggAnimation();
  }

  updateEasterEggAnimation() {
    const key = "777 Bateo Gambling - CASINÒ VENEZIA";
    const isVisible = this.state.directionVisibility[key] === true;

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

    const parts = [];
    const add = (label, val) => {
      if (val !== null && val !== undefined && val !== "") parts.push(`${label}: ${val}`);
    };
    add("Linea", bus.lineLabel);
    add("Destinazione", bus.destination);
    add("Partenza", bus.departure);

    const badge = isOffline
      ? `<span id="info-update-badge" style="display:inline-block; padding:2px 6px; border-radius:10px; background: rgba(180, 60, 60, 0.25); border: 1px solid rgba(180, 60, 60, 0.55);">offline/errore</span>`
      : `<span id="info-update-badge" style="display:inline-block; padding:2px 6px; border-radius:10px; background: rgba(60, 180, 120, 0.18); border: 1px solid rgba(60, 180, 120, 0.45);">Aggiornato ${(lastSelectedMoveAt ? Math.max(0, Math.floor((now - lastSelectedMoveAt) / 1000)) : Math.max(0, Math.floor((now - lastSuccessAt) / 1000)))}s fa</span>`;

    parts.push(badge);

    add("Race", bus.race);
    add("Vehicle", bus.vehicle);

    const baseTs = lastSelectedMoveAt || lastSuccessAt;
    if (baseTs) {
      const dt = new Date(baseTs);
      const hh = String(dt.getHours()).padStart(2, '0');
      const mm = String(dt.getMinutes()).padStart(2, '0');
      const ss = String(dt.getSeconds()).padStart(2, '0');
      add("Ultimo aggiornamento", `${hh}:${mm}:${ss}`);
    }

    this.infoDiv.innerHTML = parts.join("<br/>");
    this.infoDiv.style.display = 'block';
  }

  updateInfoAgeBadge() {
    if (!this.infoDiv || this.infoDiv.style.display === 'none') return;
    const badge = this.infoDiv.querySelector('#info-update-badge');
    if (!badge) return;

    const now = Date.now();
    const lastSuccessAt = this.state.updateStatus.lastSuccessAt || 0;
    const lastErrorAt = this.state.updateStatus.lastErrorAt || 0;
    const lastSelectedMoveAt = this.state.updateStatus.lastSelectedMoveAt || 0;
    const isOffline = lastErrorAt > lastSuccessAt;

    if (isOffline) {
      badge.textContent = 'offline/errore';
      badge.style.background = 'rgba(180, 60, 60, 0.25)';
      badge.style.border = '1px solid rgba(180, 60, 60, 0.55)';
      return;
    }

    const base = lastSelectedMoveAt || lastSuccessAt;
    const ageSec = base ? Math.max(0, Math.floor((now - base) / 1000)) : null;
    badge.textContent = `Aggiornato ${ageSec === null ? '?' : ageSec}s fa`;
    badge.style.background = 'rgba(60, 180, 120, 0.18)';
    badge.style.border = '1px solid rgba(60, 180, 120, 0.45)';
  }

  updateInfoFromTrack(lineConf, direction) {
    if (!lineConf) {
        this.infoDiv.style.display = 'none';
        this.infoDiv.innerHTML = "";
        return;
    }
    const parts = [];
    const add = (label, val) => {
      if (val !== null && val !== undefined && val !== "") parts.push(`${label}: ${val}`);
    };
    add("Linea", lineConf.label);
    add("Direzione", direction);
    this.infoDiv.innerHTML = parts.join("<br/>");
    this.infoDiv.style.display = 'block';
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
