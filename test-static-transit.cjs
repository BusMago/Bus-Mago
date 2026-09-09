const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function layer(latlngs, options = {}) {
  return {
    latlngs,
    options: { ...options },
    addTo() { return this; },
    on() { return this; },
    setLatLngs(value) { this.latlngs = value; return this; },
    getLatLngs() { return this.latlngs; },
    setLatLng(value) { this.latlngs = value; return this; },
    setStyle() { return this; }
  };
}

let fetchCalls = [];
const context = {
  window: {},
  document: {
    addEventListener() {},
    querySelector() { return { style: { display: 'none' } }; },
    getElementById() { return { style: { display: 'none' } }; }
  },
  location: { hostname: 'example.test' },
  navigator: {},
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  AbortController,
  DOMException,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame() { return 1; },
  cancelAnimationFrame() {},
  console,
  fetch: async url => {
    fetchCalls.push(String(url));
    if (String(url).includes('LineGeoTrack')) {
      return { ok: true, json: async () => [[[13.78, 45.65], [13.79, 45.66]]] };
    }
    if (String(url).includes('getlinetimetable')) {
      return { ok: true, json: async () => [
        { StopCode: '03018', StopDescription: 'Fermata corrente', SequenceNumber: 1 },
        { StopCode: '03019', StopDescription: 'Fermata successiva', SequenceNumber: 2 }
      ] };
    }
    throw new Error(`Fetch inattesa: ${url}`);
  },
  L: {
    polyline: (points, options) => layer(points, options),
    circleMarker: (point, options) => layer(point, options),
    DomEvent: { preventDefault() {}, stopPropagation() {} }
  }
};
vm.createContext(context);
for (const file of ['lines.js', 'stops.js', 'tracks.js', 'script.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
}

const app = vm.runInContext('app', context);
app.state.staticTransit.data = JSON.parse(fs.readFileSync('trips.json', 'utf8'));
const staticData = app.state.staticTransit.data;
assert(staticData.shapes.length > 0);
staticData.shapes.forEach((shape, index) => {
  const coordinates = app.decodeRoutePolyline(shape);
  assert(coordinates.length >= 2, `shape ${index} non decodificabile`);
  assert(coordinates.every(pair => pair.length === 2 && pair.every(Number.isFinite)));
});
Object.entries(staticData.trips).forEach(([key, entry]) => {
  assert(/^.+\|[AR]\|.+$/.test(key), `chiave corsa non valida: ${key}`);
  assert(entry[0] >= 0 && entry[0] < staticData.shapes.length);
  assert(entry[1] >= 0 && entry[1] < staticData.stopPatterns.length);
  assert(entry[2] >= 0 && entry[2] < staticData.timePatterns.length);
  assert.equal(staticData.stopPatterns[entry[1]].length, staticData.timePatterns[entry[2]].length);
});
app.state.map = { removeLayer() {} };
app.getLegendLineColor = () => '#123456';
app.updateTrackStyles = () => {};
app.reorientStationaryBuses = () => {};
app._rateSlot = async () => {};

(async () => {
  await app.ensureStopsIndex();
  assert.equal(app.stopsIndex.byCode.size, 1427);
  assert.equal(fetchCalls.length, 0, 'l’indice completo non deve scaricare il GeoJSON');

  const configs = context.window.linesConfig;
  const fixture = Object.entries(staticData.trips).map(([key, entry]) => {
    const [lineCode, direction, race] = key.split('|');
    const config = configs.find(item => item.code === lineCode);
    const destination = config && Object.values(config.directions || {}).flat(Infinity)
      .find(value => app.normalizeTransitLabel(value) === entry[4]);
    const stopPattern = staticData.stopPatterns[entry[1]];
    const stopIndex = config && stopPattern.findIndex(code => config.stops.includes(String(code)));
    return { entry, lineCode, direction, race, config, destination, stopPattern, stopIndex };
  }).find(item => item.config && item.destination && item.stopIndex >= 0);
  assert(fixture, 'serve almeno una corsa GTFS associabile alle linee configurate');
  const scheduledMinute = fixture.entry[3]
    + staticData.timePatterns[fixture.entry[2]][fixture.stopIndex];
  const hh = String(Math.floor((scheduledMinute % 1440) / 60)).padStart(2, '0');
  const mm = String(scheduledMinute % 60).padStart(2, '0');
  const coherent = {
    Line: `T${fixture.lineCode.padStart(2, '0')}`,
    LineCode: fixture.lineCode,
    Direction: fixture.direction,
    Race: fixture.race,
    Destination: fixture.destination,
    Time: `2026-09-09T${hh}:${mm}:00`,
    _detectedAtStop: fixture.stopPattern[fixture.stopIndex]
  };
  const match = app.getStaticTripMatch(coherent);
  assert(match && match.coordinates.length > 2);
  const wrongMinute = (scheduledMinute + 10) % 1440;
  const wrongTime = `2026-09-09T${String(Math.floor(wrongMinute / 60)).padStart(2, '0')}:${String(wrongMinute % 60).padStart(2, '0')}:00`;
  assert.equal(app.getStaticTripMatch({ ...coherent, Time: wrongTime }), null);
  assert.equal(app.getStaticTripMatch({ ...coherent, Destination: 'DESTINAZIONE DIVERSA' }), null);

  const expectedStops = new Set(configs.flatMap(config => config.stops.map(String)));
  assert.equal(expectedStops.size, context.window.staticStops.length);
  assert(context.window.staticStops.every(row => expectedStops.has(String(row[0]))));
  const expectedTrackKeys = new Set(configs.flatMap(config => Object.values(config.directions || {})
    .flat(Infinity).map(destination => `${config.code}_${String(destination).trim().toUpperCase()}`)));
  assert.equal(expectedTrackKeys.size, 192);
  assert.deepEqual(new Set(Object.keys(context.window.routeTracks)), expectedTrackKeys);
  Object.keys(context.window.routeTracks).forEach(key => {
    assert(app.getDefaultTrackCoordinates(key).length >= 2, `traccia base ${key} non decodificabile`);
  });
  configs.forEach(config => { app.state.lineVisibility[config.code] = true; });
  await Promise.all(app.processTracks({}));
  assert.equal(Object.keys(app.state.routeLayers).length, 192);
  assert(Object.values(app.state.routeLayers).every(value => value.options.trackSource === 'static'));

  configs.forEach(config => { app.state.lineVisibility[config.code] = config.code === fixture.lineCode; });
  app.processTracks({ [coherent._detectedAtStop]: [{ ...coherent, IsStarted: true, Vehicle: '11810' }] });
  const trackKey = `${fixture.lineCode}_${fixture.destination.trim().toUpperCase()}`;
  assert.equal(app.state.routeLayers[trackKey].options.trackSource, 'gtfs');
  assert.equal(fetchCalls.length, 0, 'una corrispondenza coerente non deve chiamare LineGeoTrack');

  const bus = {
    lineToken: coherent.Line, lineCode: fixture.lineCode,
    direction: fixture.direction, race: fixture.race,
    destination: fixture.destination, scheduledTime: coherent.Time,
    detectedAtStop: coherent._detectedAtStop, key: '11810'
  };
  const timetable = await app.ensureVehicleTimetable(bus);
  assert.equal(timetable.source, 'gtfs');
  assert.equal(timetable.stops.length, fixture.stopPattern.length);
  assert(Number.isFinite(timetable.stops[0].scheduledMinute));
  assert.equal(fetchCalls.length, 0, 'una sequenza GTFS coerente non deve chiamare getlinetimetable');

  const changedTimetable = await app.ensureVehicleTimetable({ ...bus, scheduledTime: wrongTime });
  assert.equal(changedTimetable.source, 'api');
  assert.equal(changedTimetable.stops.length, 2);
  assert(fetchCalls.some(url => url.includes('getlinetimetable')),
    'una voce GTFS in cache va rivalidata contro il realtime più recente');

  const inconsistent = { ...coherent, Race: 'race-non-gtfs', IsStarted: true, Vehicle: '11811' };
  app.processTracks({ [coherent._detectedAtStop]: [inconsistent] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(fetchCalls.some(url => url.includes('LineGeoTrack')));
  assert.equal(app.state.routeLayers[trackKey].options.trackSource, 'api');

  console.log(JSON.stringify({
    staticStops: app.stopsIndex.byCode.size,
    baseTracks: 192,
    matchedTripStops: timetable.stops.length,
    realtimeFallbackCalls: fetchCalls.length
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
