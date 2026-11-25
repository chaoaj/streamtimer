#!/usr/bin/env python3
"""
Stream Timer data updater
=========================

Refreshes shows.json for Stream Timer from two free online sources:

  * TVmaze (https://www.tvmaze.com/api) - TV series episode dates. No key needed.
  * TMDB   (https://developer.themoviedb.org) - movie streaming release dates.
            Needs a free API key (v3 key or v4 read token) in TMDB_API_KEY,
            or passed with --tmdb-key. Without a key, movies are skipped.

What it does
------------
1. Tracked titles (from tracklist.json): refreshes the episode dates of every
   series you track, and the streaming date of every movie you track. Tracked
   titles missing from shows.json are looked up and added.
2. New releases: scans the next --days days for new streaming seasons on the
   eight Stream Timer services (TVmaze streaming schedule) and, with a TMDB key,
   new movies streaming on those services.
3. Writes shows.json (a backup is saved as shows.json.bak first) and prints
   what changed. Nothing is ever deleted unless you pass --prune.

Entries you edited by hand are kept. An entry with "locked": true is never
changed by this script.

Usage
-----
    python update_data.py                       # update ./shows.json
    python update_data.py --dry-run             # show what would change
    python update_data.py --days 150 --max-new 30
    TMDB_API_KEY=xxxx python update_data.py     # also pull movies
    python update_data.py --shows ../shows.json --tracklist ../tracklist.json

Then load the new shows.json in Stream Timer with "Import JSON", or publish it
next to the page so "Update shows" picks it up.

Only the Python standard library is used (Python 3.8+).
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SERVICE_IDS = ['netflix', 'hulu', 'disney', 'hbomax', 'paramount', 'peacock', 'apple', 'prime']

# TVmaze streaming "web channels": name -> (Stream Timer service, days until it streams)
TVMAZE_WEB = {
    'netflix': ('netflix', 0), 'hulu': ('hulu', 0), 'disney+': ('disney', 0),
    'hbo max': ('hbomax', 0), 'max': ('hbomax', 0),
    'paramount+': ('paramount', 0), 'paramount+ with showtime': ('paramount', 0),
    'peacock': ('peacock', 0), 'apple tv+': ('apple', 0), 'apple tv': ('apple', 0),
    'prime video': ('prime', 0), 'amazon prime video': ('prime', 0), 'amazon': ('prime', 0),
}
# TV networks whose shows stream on a service (usually the next day)
TVMAZE_NETWORKS = {
    'hbo': ('hbomax', 0), 'cbs': ('paramount', 1), 'showtime': ('paramount', 0),
    'nbc': ('peacock', 1), 'bravo': ('peacock', 1), 'abc': ('hulu', 1), 'fox': ('hulu', 1),
    'fx': ('hulu', 1), 'fxx': ('hulu', 1), 'freeform': ('hulu', 1), 'disney channel': ('disney', 1),
}
# TMDB watch-provider names -> service (matched case-insensitively)
TMDB_PROVIDERS = [
    ('netflix', r'^netflix$'),
    ('hulu', r'^hulu$'),
    ('disney', r'^disney( plus|\+)$'),
    ('hbomax', r'^(hbo max|max)$'),
    ('paramount', r'^paramount( plus|\+)( essential| premium| with showtime)?$'),
    ('peacock', r'^peacock( premium( plus)?)?$'),
    ('apple', r'^apple tv( plus|\+)?$'),
    ('prime', r'^amazon prime video$'),
]

TVMAZE = 'https://api.tvmaze.com'
TMDB = 'https://api.themoviedb.org/3'


# ---------------------------------------------------------------- helpers
def log(msg):
    print(msg, flush=True)


def slug(text):
    s = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')
    return s or 'item'


def parse_title(title):
    """'Yellowjackets (Season 4, final)' -> ('Yellowjackets', 4)."""
    m = re.match(r'^(.*?)\s*\((?:.*?\bSeason\s+(\d+))?.*\)\s*$', title)
    if m:
        return m.group(1).strip(), (int(m.group(2)) if m.group(2) else None)
    return title.strip(), None


def ymd(d):
    return d.isoformat()


def to_date(s):
    try:
        return dt.date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- HTTP
class Http:
    """Small JSON client with polite rate limiting and retries."""

    def __init__(self, min_interval=0.55, timeout=20, headers=None):
        self.min_interval = min_interval
        self.timeout = timeout
        self.headers = headers or {}
        self._last = 0.0

    def get(self, url, params=None):
        if params:
            url += ('&' if '?' in url else '?') + urllib.parse.urlencode(params)
        for attempt in range(4):
            wait = self.min_interval - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.time()
            req = urllib.request.Request(url, headers={'User-Agent': 'StreamTimer-updater/1.0', **self.headers})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return json.loads(r.read().decode('utf-8'))
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise
            except urllib.error.URLError:
                if attempt < 3:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise
        return None


# ---------------------------------------------------------------- TVmaze
def tvmaze_service(show):
    """Map a TVmaze show to (service, day offset) or (None, 0)."""
    wc = (show or {}).get('webChannel') or {}
    if wc.get('name'):
        hit = TVMAZE_WEB.get(wc['name'].strip().lower())
        if hit:
            return hit
    net = (show or {}).get('network') or {}
    if net.get('name'):
        hit = TVMAZE_NETWORKS.get(net['name'].strip().lower())
        if hit:
            return hit
    return None, 0


def tvmaze_find(http, title, tvmaze_id=None):
    if tvmaze_id:
        return http.get(f'{TVMAZE}/shows/{int(tvmaze_id)}')
    base, _ = parse_title(title)
    return http.get(f'{TVMAZE}/singlesearch/shows', {'q': base})


def tvmaze_season(http, show_id, season):
    """Dated episodes of one season: [(number, date)] sorted by date."""
    eps = http.get(f'{TVMAZE}/shows/{int(show_id)}/episodes') or []
    out = []
    for e in eps:
        if e.get('season') != season or e.get('number') is None:
            continue
        d = to_date(e.get('airdate'))
        if d:
            out.append((int(e['number']), d))
    out.sort(key=lambda x: (x[1], x[0]))
    return out


def latest_season(http, show_id, today):
    """Season with upcoming episodes, else the newest dated season."""
    eps = http.get(f'{TVMAZE}/shows/{int(show_id)}/episodes') or []
    future = [e['season'] for e in eps if to_date(e.get('airdate')) and to_date(e['airdate']) >= today]
    if future:
        return min(future)
    dated = [e['season'] for e in eps if to_date(e.get('airdate'))]
    return max(dated) if dated else None


def series_episodes(tv_eps, offset, existing=None):
    """Build the episodes list; keep existing estimated dates for numbers TVmaze lacks."""
    by_n = {n: d + dt.timedelta(days=offset) for n, d in tv_eps}
    complete = True
    if existing:
        for e in existing.get('episodes', []):
            n = int(e.get('n', 0))
            if n and n not in by_n and to_date(e.get('date')):
                by_n[n] = to_date(e['date'])
                complete = False
    eps = [{'n': n, 'date': ymd(d)} for n, d in sorted(by_n.items(), key=lambda kv: (kv[1], kv[0]))]
    return eps, complete


# ---------------------------------------------------------------- TMDB
class Tmdb:
    def __init__(self, http, key):
        self.http = http
        self.key = key
        if key and key.startswith('eyJ'):       # v4 read access token
            http.headers['Authorization'] = f'Bearer {key}'
            self.params = {}
        else:
            self.params = {'api_key': key}
        self._providers = None

    def get(self, path, params=None):
        return self.http.get(f'{TMDB}{path}', {**self.params, **(params or {})})

    def provider_ids(self):
        """service -> [TMDB provider ids] for the US, matched by provider name."""
        if self._providers is None:
            res = self.get('/watch/providers/movie', {'watch_region': 'US'}) or {}
            out = {k: [] for k in SERVICE_IDS}
            for p in res.get('results', []):
                name = (p.get('provider_name') or '').strip().lower()
                for svc, pat in TMDB_PROVIDERS:
                    if re.match(pat, name):
                        out[svc].append(p['provider_id'])
            self._providers = out
        return self._providers

    def us_streaming_date(self, movie_id):
        """Earliest US digital (4) or TV (6) release date, if TMDB has one."""
        res = self.get(f'/movie/{int(movie_id)}/release_dates') or {}
        dates = []
        for c in res.get('results', []):
            if c.get('iso_3166_1') != 'US':
                continue
            for r in c.get('release_dates', []):
                if r.get('type') in (4, 6) and to_date(r.get('release_date')):
                    dates.append(to_date(r['release_date']))
        return min(dates) if dates else None

    def service_of(self, movie_id):
        res = self.get(f'/movie/{int(movie_id)}/watch/providers') or {}
        us = (res.get('results') or {}).get('US') or {}
        ids = self.provider_ids()
        for p in us.get('flatrate', []) or []:
            for svc, pids in ids.items():
                if p.get('provider_id') in pids:
                    return svc
        return None


# ---------------------------------------------------------------- updater
class Updater:
    def __init__(self, data, tracklist, http, tmdb=None, today=None, days=120, max_new=25,
                 types=('Scripted', 'Animation'), languages=('English',), include_network=False):
        self.data = data
        self.tracklist = tracklist or {'tracked': []}
        self.http = http
        self.tmdb = tmdb
        self.today = today or dt.date.today()
        self.days = days
        self.max_new = max_new
        self.types = set(types)
        self.languages = set(languages)
        self.include_network = include_network
        self.by_id = {s['id']: s for s in data['shows']}
        self.changes = {'added': [], 'updated': [], 'unchanged': 0, 'warnings': []}

    # ---- bookkeeping
    def warn(self, msg):
        self.changes['warnings'].append(msg)
        log('  ! ' + msg)

    def _put(self, entry, is_new):
        if is_new:
            base, n = entry['id'], 2
            while entry['id'] in self.by_id:
                entry['id'] = f'{base}-{n}'
                n += 1
            self.data['shows'].append(entry)
            self.by_id[entry['id']] = entry
            self.changes['added'].append(entry['title'])
        else:
            self.changes['updated'].append(entry['title'])

    def find_by_source(self, key, value, season=None):
        for s in self.data['shows']:
            src = s.get('sources') or {}
            if str(src.get(key)) == str(value) and (season is None or src.get('season') == season):
                return s
        return None

    # ---- series
    def refresh_series(self, entry):
        if entry.get('locked'):
            return
        src = entry.setdefault('sources', {})
        show = tvmaze_find(self.http, entry['title'], src.get('tvmaze'))
        if not show:
            self.warn(f'TVmaze: no match for "{entry["title"]}"')
            return
        season = src.get('season') or parse_title(entry['title'])[1] or latest_season(self.http, show['id'], self.today)
        if not season:
            self.warn(f'TVmaze: no season found for "{entry["title"]}"')
            return
        svc, offset = tvmaze_service(show)
        if svc and svc != entry['service']:
            self.warn(f'"{entry["title"]}": TVmaze lists {svc}, shows.json says {entry["service"]} (kept yours)')
        offset = int(src.get('streamOffsetDays', offset if svc == entry['service'] else 0))
        tv = tvmaze_season(self.http, show['id'], season)
        if not tv:
            self.warn(f'TVmaze: no dated episodes yet for "{entry["title"]}" season {season}')
            src.update(tvmaze=show['id'], season=season)
            return
        eps, complete = series_episodes(tv, offset, entry)
        before = json.dumps([entry.get('episodes'), entry.get('confidence')])
        entry['episodes'] = eps
        entry['confidence'] = 'confirmed' if complete else 'estimated'
        src.update(tvmaze=show['id'], season=season, streamOffsetDays=offset, checked=ymd(self.today))
        if json.dumps([entry['episodes'], entry['confidence']]) != before:
            self._put(entry, False)
        else:
            self.changes['unchanged'] += 1

    def add_series(self, show, season, offset, svc, why):
        tv = tvmaze_season(self.http, show['id'], season)
        if not tv:
            return None
        eps, _ = series_episodes(tv, offset)
        name = show['name']
        entry = {
            'id': f'{slug(name)}-{season}', 'title': f'{name} (Season {season})', 'service': svc,
            'type': 'series', 'confidence': 'confirmed',
            'note': f'{why} {len(eps)} episodes listed on TVmaze so far'
                    + (f'; streams {offset} day after it airs.' if offset else '.'),
            'episodes': eps,
            'sources': {'tvmaze': show['id'], 'season': season, 'streamOffsetDays': offset, 'checked': ymd(self.today)},
        }
        self._put(entry, True)
        return entry

    def scan_new_series(self):
        log(f'Scanning TVmaze for new seasons, {self.today} + {self.days} days…')
        cands = {}   # (show id, season) -> (show, first date, has episode 1)
        endpoints = [('/schedule/web', {})]
        if self.include_network:
            endpoints.append(('/schedule', {'country': 'US'}))
        for i in range(self.days + 1):
            day = self.today + dt.timedelta(days=i)
            for path, extra in endpoints:
                items = self.http.get(f'{TVMAZE}{path}', {'date': ymd(day), **extra}) or []
                for it in items:
                    show = (it.get('_embedded') or {}).get('show') or it.get('show') or {}
                    svc, _ = tvmaze_service(show)
                    if not svc:
                        continue
                    wc = show.get('webChannel') or {}
                    country = ((wc.get('country') or {}).get('code')) if wc else ((show.get('network') or {}).get('country') or {}).get('code')
                    if country not in (None, 'US'):
                        continue
                    if self.types and show.get('type') not in self.types:
                        continue
                    if self.languages and show.get('language') not in self.languages:
                        continue
                    key = (show['id'], it.get('season'))
                    c = cands.setdefault(key, [show, day, False])
                    c[1] = min(c[1], day)
                    if it.get('number') == 1:
                        c[2] = True
        added = 0
        for (sid, season), (show, firstday, premiere) in sorted(cands.items(), key=lambda kv: kv[1][1]):
            if season is None:
                continue
            existing = self.find_by_source('tvmaze', sid, season)
            if existing:
                continue          # tracked/known: refreshed separately
            if not premiere:
                continue          # mid-season episodes of something we don't list
            if added >= self.max_new:
                self.warn(f'Stopped after {self.max_new} new seasons (raise --max-new for more)')
                break
            svc, offset = tvmaze_service(show)
            if self.add_series(show, season, offset, svc, f'New season premiering {firstday:%b %d, %Y}.'):
                added += 1

    # ---- movies
    def refresh_movie(self, entry):
        if entry.get('locked') or not self.tmdb:
            return
        src = entry.setdefault('sources', {})
        mid = src.get('tmdb')
        if not mid:
            res = self.tmdb.get('/search/movie', {'query': entry['title'], 'region': 'US'}) or {}
            hits = res.get('results') or []
            if not hits:
                self.warn(f'TMDB: no match for movie "{entry["title"]}"')
                return
            mid = hits[0]['id']
        d = self.tmdb.us_streaming_date(mid)
        src.update(tmdb=mid, checked=ymd(self.today))
        if not d:
            self.warn(f'TMDB: no US streaming date yet for "{entry["title"]}"')
            return
        new = [{'n': 1, 'date': ymd(d)}]
        if entry.get('episodes') != new or entry.get('confidence') != 'confirmed':
            entry['episodes'] = new
            entry['confidence'] = 'confirmed'
            self._put(entry, False)
        else:
            self.changes['unchanged'] += 1

    def scan_new_movies(self):
        if not self.tmdb:
            log('No TMDB key: skipping movies (set TMDB_API_KEY to include them).')
            return
        log(f'Scanning TMDB for movies streaming {self.today} + {self.days} days…')
        ids = self.tmdb.provider_ids()
        end = self.today + dt.timedelta(days=self.days)
        added = 0
        for svc in SERVICE_IDS:
            if not ids.get(svc):
                self.warn(f'TMDB: no provider id found for {svc}')
                continue
            res = self.tmdb.get('/discover/movie', {
                'watch_region': 'US', 'with_watch_providers': '|'.join(map(str, ids[svc])),
                'with_watch_monetization_types': 'flatrate', 'region': 'US', 'with_release_type': '4|6',
                'release_date.gte': ymd(self.today), 'release_date.lte': ymd(end),
                'sort_by': 'popularity.desc', 'include_adult': 'false',
            }) or {}
            for m in (res.get('results') or [])[:10]:
                if self.find_by_source('tmdb', m['id']) or added >= self.max_new:
                    continue
                d = self.tmdb.us_streaming_date(m['id']) or to_date(m.get('release_date'))
                if not d or d < self.today or d > end:
                    continue
                title = m.get('title') or m.get('original_title') or 'Untitled'
                entry = {
                    'id': f'{slug(title)}-movie', 'title': title, 'service': svc, 'type': 'movie',
                    'confidence': 'confirmed',
                    'note': f'Movie streaming on {svc} from {d:%b %d, %Y} (TMDB US digital release).',
                    'episodes': [{'n': 1, 'date': ymd(d)}],
                    'sources': {'tmdb': m['id'], 'checked': ymd(self.today)},
                }
                self._put(entry, True)
                added += 1

    # ---- tracked titles
    def tracked_missing(self):
        """Tracked items not in shows.json: try TVmaze as a series, then TMDB as a movie."""
        for t in self.tracklist.get('tracked', []):
            if t.get('id') in self.by_id:
                continue
            title = t.get('title') or t.get('id')
            show = tvmaze_find(self.http, title)
            svc, offset = tvmaze_service(show) if show else (None, 0)
            if show and svc:
                season = parse_title(title)[1] or latest_season(self.http, show['id'], self.today)
                if season:
                    e = self.add_series(show, season, offset, svc, 'Added because you track it.')
                    if e:
                        e['id_tracked'] = t['id']
                        continue
            if self.tmdb:
                res = self.tmdb.get('/search/movie', {'query': title, 'region': 'US'}) or {}
                for m in (res.get('results') or [])[:1]:
                    d = self.tmdb.us_streaming_date(m['id'])
                    svc = self.tmdb.service_of(m['id']) or t.get('service')
                    if d and svc in SERVICE_IDS:
                        self._put({'id': t['id'], 'title': m.get('title') or title, 'service': svc, 'type': 'movie',
                                   'confidence': 'confirmed', 'note': 'Added because you track it (TMDB).',
                                   'episodes': [{'n': 1, 'date': ymd(d)}],
                                   'sources': {'tmdb': m['id'], 'checked': ymd(self.today)}}, True)
                        break
                else:
                    self.warn(f'Tracked "{title}" was not found online')
            else:
                self.warn(f'Tracked "{title}" was not found on TVmaze (add a TMDB key to look for movies)')

    def run(self, refresh_all=False, scan=True):
        tracked = {t.get('id') for t in self.tracklist.get('tracked', [])}
        log(f'Refreshing {"all" if refresh_all else "tracked"} titles…')
        for entry in list(self.data['shows']):
            if not refresh_all and entry['id'] not in tracked:
                continue
            if entry.get('type') == 'movie':
                self.refresh_movie(entry)
            else:
                self.refresh_series(entry)
        self.tracked_missing()
        if scan:
            self.scan_new_series()
            self.scan_new_movies()
        # the app uses the tracked id: keep tracklist links working
        for e in self.data['shows']:
            tid = e.pop('id_tracked', None)
            if tid and tid not in self.by_id:
                self.by_id.pop(e['id'], None)
                e['id'] = tid
                self.by_id[tid] = e
        self.data['dataCheckedOn'] = ymd(self.today)
        return self.changes

    def prune(self, before):
        tracked = {t.get('id') for t in self.tracklist.get('tracked', [])}
        keep, dropped = [], []
        for s in self.data['shows']:
            last = max((to_date(e['date']) for e in s.get('episodes', []) if to_date(e.get('date'))), default=None)
            if last and last < before and s['id'] not in tracked and not s.get('locked'):
                dropped.append(s['title'])
            else:
                keep.append(s)
        self.data['shows'] = keep
        return dropped


# ---------------------------------------------------------------- validation
def validate(data):
    """Same rules the Stream Timer page applies when it loads shows.json."""
    errs = []
    svcs = {s.get('id') for s in data.get('services', [])}
    ids = set()
    for s in data.get('shows', []):
        t = s.get('title', '?')
        if not s.get('id') or not s.get('title'):
            errs.append(f'"{t}": needs an id and a title')
        if s.get('id') in ids:
            errs.append(f'"{t}": duplicate id {s.get("id")}')
        ids.add(s.get('id'))
        if s.get('service') not in svcs:
            errs.append(f'"{t}": unknown service {s.get("service")}')
        eps = s.get('episodes') or []
        if not eps:
            errs.append(f'"{t}": no episodes/date')
        for e in eps:
            if not re.match(r'^\d{4}-\d{2}-\d{2}$', str(e.get('date', ''))):
                errs.append(f'"{t}": bad date {e.get("date")}')
        if s.get('type', 'series') not in ('series', 'movie'):
            errs.append(f'"{t}": type must be series or movie')
    return errs


# ---------------------------------------------------------------- CLI
def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description='Update Stream Timer shows.json from TVmaze (series) and TMDB (movies).')
    ap.add_argument('--shows', default=None, help='path to shows.json (default: ./shows.json or ../shows.json)')
    ap.add_argument('--tracklist', default=None, help='path to tracklist.json (default: next to shows.json)')
    ap.add_argument('--out', default=None, help='write here instead of overwriting --shows')
    ap.add_argument('--days', type=int, default=120, help='how far ahead to look for new releases (default 120)')
    ap.add_argument('--max-new', type=int, default=25, help='max new seasons and max new movies to add (default 25 each)')
    ap.add_argument('--types', default='Scripted,Animation', help='TVmaze show types to add (default Scripted,Animation)')
    ap.add_argument('--languages', default='English', help='TVmaze languages to add (blank for any)')
    ap.add_argument('--include-network', action='store_true', help='also scan US network schedules (CBS→Paramount+, NBC→Peacock…)')
    ap.add_argument('--refresh-all', action='store_true', help='refresh every title, not just tracked ones')
    ap.add_argument('--no-scan', action='store_true', help='only refresh tracked titles; skip new releases')
    ap.add_argument('--prune', action='store_true', help='remove untracked titles that ended more than 60 days ago')
    ap.add_argument('--tmdb-key', default=os.environ.get('TMDB_API_KEY', ''), help='TMDB key (or set TMDB_API_KEY)')
    ap.add_argument('--dry-run', action='store_true', help='show changes without writing')
    a = ap.parse_args(argv)

    shows_path = a.shows or next((p for p in [os.path.join(os.getcwd(), 'shows.json'), os.path.join(here, '..', 'shows.json')]
                                  if os.path.exists(p)), 'shows.json')
    track_path = a.tracklist or os.path.join(os.path.dirname(os.path.abspath(shows_path)), 'tracklist.json')
    with open(shows_path, encoding='utf-8') as f:
        data = json.load(f)
    tracklist = {'tracked': []}
    if os.path.exists(track_path):
        with open(track_path, encoding='utf-8') as f:
            tracklist = json.load(f)
        log(f'Tracklist: {len(tracklist.get("tracked", []))} titles from {track_path}')
    else:
        log('No tracklist.json found: only new releases will be scanned.')

    http = Http()
    tmdb = Tmdb(Http(min_interval=0.1), a.tmdb_key) if a.tmdb_key else None
    up = Updater(data, tracklist, http, tmdb, days=a.days, max_new=a.max_new,
                 types=[t for t in a.types.split(',') if t], languages=[l for l in a.languages.split(',') if l],
                 include_network=a.include_network)
    ch = up.run(refresh_all=a.refresh_all, scan=not a.no_scan)
    dropped = up.prune(dt.date.today() - dt.timedelta(days=60)) if a.prune else []

    errs = validate(data)
    log('')
    log(f'Added ({len(ch["added"])}): ' + ('; '.join(ch['added']) or 'none'))
    log(f'Updated ({len(ch["updated"])}): ' + ('; '.join(ch['updated']) or 'none'))
    log(f'Unchanged: {ch["unchanged"]}' + (f' · Pruned: {"; ".join(dropped)}' if dropped else ''))
    if ch['warnings']:
        log(f'Warnings: {len(ch["warnings"])} (see above)')
    if errs:
        log('NOT WRITTEN - the result would not load in Stream Timer:')
        for e in errs:
            log('  - ' + e)
        return 2
    if a.dry_run:
        log('Dry run: nothing written.')
        return 0
    out = a.out or shows_path
    if os.path.exists(out) and not a.out:
        shutil.copyfile(out, out + '.bak')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')
    log(f'Wrote {out}' + ('' if a.out else f' (backup: {out}.bak)'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
