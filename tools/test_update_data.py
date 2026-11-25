"""Offline tests for update_data.py (no network). Run: python -m unittest test_update_data.py"""
import copy
import datetime as dt
import json
import os
import sys
import unittest
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import update_data as U  # noqa: E402

TODAY = dt.date(2026, 11, 25)


class FakeHttp:
    """Answers by URL path; records calls. Unknown paths return [] (empty schedule)."""
    def __init__(self, routes):
        self.routes = routes
        self.headers = {}
        self.calls = []

    def get(self, url, params=None):
        path = urllib.parse.urlparse(url).path
        self.calls.append((path, params or {}))
        r = self.routes.get(path)
        return r(params or {}) if callable(r) else copy.deepcopy(r) if r is not None else []


def ep(season, number, date):
    return {'season': season, 'number': number, 'airdate': date}


YJ = {'id': 101, 'name': 'Yellowjackets', 'type': 'Scripted', 'language': 'English',
      'webChannel': {'name': 'Paramount+', 'country': {'code': 'US'}}, 'network': None}
MARSHALS = {'id': 202, 'name': 'Marshals', 'type': 'Scripted', 'language': 'English',
            'webChannel': None, 'network': {'name': 'CBS', 'country': {'code': 'US'}}}
NEWSHOW = {'id': 303, 'name': 'Brand New Show', 'type': 'Scripted', 'language': 'English',
           'webChannel': {'name': 'Netflix', 'country': None}, 'network': None}
REALITY = {'id': 404, 'name': 'Some Reality', 'type': 'Reality', 'language': 'English',
           'webChannel': {'name': 'Netflix', 'country': None}, 'network': None}


def base_data():
    return {
        'services': [{'id': k, 'name': k} for k in U.SERVICE_IDS],
        'shows': [
            {'id': 'yellowjackets-4', 'title': 'Yellowjackets (Season 4, final)', 'service': 'paramount',
             'type': 'series', 'confidence': 'confirmed', 'note': '',
             'episodes': [{'n': i + 1, 'date': (dt.date(2026, 11, 20) + dt.timedelta(weeks=i)).isoformat()} for i in range(10)]},
            {'id': 'marshals-2', 'title': 'Marshals (Season 2)', 'service': 'paramount', 'type': 'series',
             'confidence': 'estimated', 'note': '',
             'episodes': [{'n': i + 1, 'date': (dt.date(2026, 10, 5) + dt.timedelta(weeks=i)).isoformat()} for i in range(8)]
             + [{'n': 9 + i, 'date': (dt.date(2027, 1, 11) + dt.timedelta(weeks=i)).isoformat()} for i in range(10)]},
            {'id': 'ray-gunn-movie', 'title': 'Ray Gunn', 'service': 'netflix', 'type': 'movie',
             'confidence': 'confirmed', 'note': '', 'episodes': [{'n': 1, 'date': '2026-12-18'}]},
            {'id': 'locked-show', 'title': 'Hand Made (Season 1)', 'service': 'hulu', 'type': 'series', 'locked': True,
             'confidence': 'estimated', 'note': '', 'episodes': [{'n': 1, 'date': '2027-01-01'}]},
        ],
    }


def tvmaze_routes():
    yj_eps = [ep(4, i + 1, (dt.date(2026, 11, 20) + dt.timedelta(weeks=i)).isoformat()) for i in range(9)]
    yj_eps.append(ep(4, 10, '2027-01-29'))      # finale moved a week
    m_eps = [ep(2, i + 1, (dt.date(2026, 10, 4) + dt.timedelta(weeks=i)).isoformat()) for i in range(8)]
    m_eps += [ep(2, 9, '2027-01-03'), ep(2, 10, '2027-01-10')]   # TVmaze knows 2 more, aired Sundays
    new_eps = [ep(1, i + 1, '2026-12-04') for i in range(6)]

    def search(p):
        q = p.get('q', '').lower()
        return {'yellowjackets': YJ, 'marshals': MARSHALS, 'severance': {**NEWSHOW, 'id': 505, 'name': 'Severance',
                'webChannel': {'name': 'Apple TV+', 'country': None}}}.get(q)

    def schedule(p):
        if p.get('date') == '2026-12-04':
            return [
                {'season': 1, 'number': 1, '_embedded': {'show': NEWSHOW}},
                {'season': 1, 'number': 2, '_embedded': {'show': NEWSHOW}},
                {'season': 3, 'number': 1, '_embedded': {'show': REALITY}},
                {'season': 4, 'number': 3, '_embedded': {'show': YJ}},
            ]
        return []

    return {
        '/singlesearch/shows': search,
        '/shows/101': YJ, '/shows/202': MARSHALS,
        '/shows/505': {**NEWSHOW, 'id': 505, 'name': 'Severance', 'webChannel': {'name': 'Apple TV+', 'country': None}},
        '/shows/101/episodes': yj_eps,
        '/shows/202/episodes': m_eps,
        '/shows/303/episodes': new_eps,
        '/shows/505/episodes': [ep(3, 1, '2027-02-05'), ep(3, 2, '2027-02-12')],
        '/schedule/web': schedule,
    }


class FakeTmdb(U.Tmdb):
    def __init__(self, routes):
        super().__init__(FakeHttp(routes), 'testkey')


def tmdb_routes():
    return {
        '/3/watch/providers/movie': {'results': [
            {'provider_id': 8, 'provider_name': 'Netflix'}, {'provider_id': 9, 'provider_name': 'Amazon Prime Video'},
            {'provider_id': 1899, 'provider_name': 'HBO Max'}, {'provider_id': 337, 'provider_name': 'Disney Plus'},
            {'provider_id': 15, 'provider_name': 'Hulu'}, {'provider_id': 531, 'provider_name': 'Paramount Plus'},
            {'provider_id': 386, 'provider_name': 'Peacock Premium'}, {'provider_id': 350, 'provider_name': 'Apple TV'}]},
        '/3/search/movie': lambda p: {'results': [{'id': 900, 'title': 'Ray Gunn'}]} if p['query'] == 'Ray Gunn' else {'results': []},
        '/3/movie/900/release_dates': {'results': [{'iso_3166_1': 'US', 'release_dates': [
            {'type': 3, 'release_date': '2026-11-01T00:00:00.000Z'}, {'type': 4, 'release_date': '2026-12-19T00:00:00.000Z'}]}]},
        '/3/discover/movie': lambda p: {'results': [{'id': 901, 'title': 'Holiday Heist', 'release_date': '2026-12-12'}]}
            if p.get('with_watch_providers') == '8' else {'results': []},
        '/3/movie/901/release_dates': {'results': [{'iso_3166_1': 'US', 'release_dates': [
            {'type': 4, 'release_date': '2026-12-12T00:00:00.000Z'}]}]},
    }


TRACK = {'tracked': [{'id': 'yellowjackets-4', 'title': 'Yellowjackets (Season 4, final)'},
                     {'id': 'marshals-2', 'title': 'Marshals (Season 2)'},
                     {'id': 'ray-gunn-movie', 'title': 'Ray Gunn'},
                     {'id': 'locked-show', 'title': 'Hand Made (Season 1)'},
                     {'id': 'severance-3', 'title': 'Severance (Season 3)', 'service': 'apple'}]}


class TestUpdater(unittest.TestCase):
    def run_updater(self, tmdb=True, days=10):
        data = base_data()
        up = U.Updater(data, copy.deepcopy(TRACK), FakeHttp(tvmaze_routes()),
                       FakeTmdb(tmdb_routes()) if tmdb else None, today=TODAY, days=days)
        ch = up.run()
        return data, ch, {s['id']: s for s in data['shows']}

    def test_parse_title(self):
        self.assertEqual(U.parse_title('Yellowjackets (Season 4, final)'), ('Yellowjackets', 4))
        self.assertEqual(U.parse_title('THE ONE PIECE (anime)'), ('THE ONE PIECE', None))
        self.assertEqual(U.parse_title('Ray Gunn'), ('Ray Gunn', None))

    def test_tracked_series_refreshed(self):
        data, ch, by = self.run_updater()
        yj = by['yellowjackets-4']
        self.assertEqual(yj['episodes'][-1], {'n': 10, 'date': '2027-01-29'})
        self.assertEqual(yj['confidence'], 'confirmed')
        self.assertIn('Yellowjackets (Season 4, final)', ch['updated'])

    def test_network_offset_and_partial_season(self):
        data, ch, by = self.run_updater()
        m = by['marshals-2']
        dates = {e['n']: e['date'] for e in m['episodes']}
        self.assertEqual(dates[1], '2026-10-05')          # CBS Sunday -> Paramount+ Monday
        self.assertEqual(dates[9], '2027-01-04')          # new TVmaze date, +1 day
        self.assertEqual(dates[18], '2027-03-15')         # kept the estimate TVmaze lacks
        self.assertEqual(m['confidence'], 'estimated')
        self.assertEqual(m['sources']['streamOffsetDays'], 1)

    def test_locked_untouched(self):
        data, ch, by = self.run_updater()
        self.assertNotIn('sources', by['locked-show'])

    def test_new_season_added_filters_reality_and_midseason(self):
        data, ch, by = self.run_updater()
        self.assertIn('brand-new-show-1', by)
        self.assertEqual(by['brand-new-show-1']['service'], 'netflix')
        self.assertEqual(len(by['brand-new-show-1']['episodes']), 6)
        self.assertFalse(any('Some Reality' in t for t in ch['added']))

    def test_tracked_missing_added_with_tracked_id(self):
        data, ch, by = self.run_updater()
        self.assertIn('severance-3', by)                  # keeps the tracklist id
        self.assertEqual(by['severance-3']['service'], 'apple')

    def test_movies(self):
        data, ch, by = self.run_updater(tmdb=True, days=30)   # Holiday Heist streams Dec 12
        self.assertEqual(by['ray-gunn-movie']['episodes'], [{'n': 1, 'date': '2026-12-19'}])
        self.assertIn('holiday-heist-movie', by)
        self.assertEqual(by['holiday-heist-movie']['type'], 'movie')
        self.assertEqual(by['holiday-heist-movie']['service'], 'netflix')

    def test_no_tmdb_key_skips_movies(self):
        data, ch, by = self.run_updater(tmdb=False)
        self.assertEqual(by['ray-gunn-movie']['episodes'], [{'n': 1, 'date': '2026-12-18'}])
        self.assertNotIn('holiday-heist-movie', by)

    def test_output_valid_and_rerun_stable(self):
        data, ch, by = self.run_updater()
        self.assertEqual(U.validate(data), [])
        up = U.Updater(data, copy.deepcopy(TRACK), FakeHttp(tvmaze_routes()), FakeTmdb(tmdb_routes()), today=TODAY, days=10)
        ch2 = up.run()
        self.assertEqual(ch2['added'], [])                # second run adds nothing new
        self.assertEqual(U.validate(data), [])

    def test_real_shows_json_validates(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'shows.json')
        with open(path) as f:
            self.assertEqual(U.validate(json.load(f)), [])

    def test_validate_catches_errors(self):
        bad = base_data()
        bad['shows'][0]['service'] = 'nope'
        bad['shows'][1]['episodes'][0]['date'] = 'Jan 5'
        self.assertEqual(len(U.validate(bad)), 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
