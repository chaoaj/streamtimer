# Stream Timer

A p5.js app that tells you **when to subscribe to and cancel** streaming services
(Netflix, Hulu, Disney+, HBO Max, Paramount+, Peacock, Apple TV, Prime Video),
based on the release schedules of the shows and movies you want to watch.

Pick shows and movies, choose **watch as it airs** or **binge after the finale**,
and Stream Timer builds a month-by-month plan: subscribe and cancel-by dates for
each service, a release timeline, costs with discounts, and a keep-or-cancel check
for subscriptions you already have.

[Production url](https://chaoaj.github.io/streamtimer/) (once GitHub Pages is turned on for this repo)

## Running it

Serve the folder with any local web server so the JSON files can load, for example:

```
python3 -m http.server
```

then open http://localhost:8000. (VS Code's Live Server or the p5.js extension also work.)
Opening `index.html` straight from disk works too, but then it uses the built-in
copies of the data and the default tracklist isn't loaded.

## Files

| File | What it is |
|---|---|
| `index.html` | Page markup, plus built-in copies of `shows.json` and `rates.json` |
| `style.css` | Styles (WCAG 2.1 AA contrast, visible focus) |
| `sketch.js` | All app code: data loading, planner, DOM rendering, p5 timeline |
| `libraries/p5.min.js` | p5.js v1.10.0 |
| `shows.json` | Series and movies with episode / release dates, services, colors |
| `tracklist.json` | Default tracklist: titles you follow long term |
| `rates.json` | Standard rates, discounts, bundles, and what you keep |
| `tools/update_data.py` | Pulls fresh data from TVmaze (series) and TMDB (movies) |
| `tools/test_update_data.py` | Offline tests for the updater |
| `tools/build.py` | Refreshes the built-in data copies in `index.html` |

## Data files

All three files use the same loading order in the app: a copy saved in the
browser first, then the file next to `index.html`, then a built-in fallback.
Each has Save / Open (or Import / Export) buttons in the app.

- **shows.json**: `shows[]` entries have `id`, `title`, `service`,
  `type` (`series` | `movie`), `confidence` (`confirmed` | `estimated`), `note`,
  and `episodes[]` (`{ "n": 1, "date": "YYYY-MM-DD" }`; a movie has one entry).
  Optional: `sources` (written by the updater) and `"locked": true` to stop the
  updater from changing an entry.
- **tracklist.json**: `tracked[]` (`id`, `title`, `service`, `status`, `notes`,
  `addedOn`) and `customShows[]` (your own entries, same format as `shows.json`).
- **rates.json**: `rates[]` per service (`plan`, `standard`, `status`:
  `keeping` | `as-needed`, `discounts[]`) and `bundles[]` (`services`, `price`,
  `status`). Discounts are `intro` (first N months for sign-ups before a date)
  or `until` (promo price until an end date, then standard).

After editing `shows.json` or `rates.json` by hand, run `python3 tools/build.py`
to refresh the built-in copies.

## Updating the data

```
cd tools
python3 update_data.py --dry-run          # preview
python3 update_data.py                    # update ../shows.json (backup: shows.json.bak)
TMDB_API_KEY=your_key python3 update_data.py   # also pull movies
python3 -m unittest test_update_data.py   # offline tests
```

The updater refreshes everything in `tracklist.json`, adds tracked titles that
are missing, and scans the next 120 days (`--days`) for new seasons and, with a
free TMDB key, new movies. Run `python3 update_data.py --help` for all options.
Then run `python3 tools/build.py`.

## Accessibility

Controls are native HTML (labels, fieldsets, keyboard focus). The canvas timeline
has a text description, and the month-by-month table and episode guides carry the
same information. Service colors are close to each brand but adjusted so labels
meet AA contrast, and each service also has its own pattern so color isn't the
only cue.
