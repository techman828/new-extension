# Upwork Job Tracker

Checks Upwork for new job postings on a configurable interval (every minute by default) and lists them on a web page.
The page and the Node.js server that checks Upwork are one project in one folder: `npm start` serves the page and
runs the checks, so monitoring keeps running while the page is closed. The checks run on the server because a web
page can't call upwork.com itself (the browser blocks cross-site requests); they use the Upwork session you give it.

## Run

Requires Node.js 20 or later.

```sh
npm install
npm start          # http://localhost:3000
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on; `0.0.0.0` to accept other machines |
| `APP_PASSWORD` | — | Asks for this password (any user name) before showing the site. Set it before listening beyond `127.0.0.1`: the server holds your Upwork session |
| `DATA_FILE` | `data/state.json` | Where jobs, settings and the Upwork session are saved |

## Connect to Upwork

1. In a browser where you are logged in to Upwork, open a job search.
2. Open the developer tools (F12) → **Network**, click any request to `www.upwork.com` and copy the value of its
   `cookie` request header.
3. On the tracker's **Connection** page, paste it into *Cookie header*, click *Use this browser's user agent* (if you
   copied the cookies from the same browser) and *Save connection*.

Or let the Chrome extension in `extension/` do it: open `chrome://extensions`, turn on *Developer mode*, click
*Load unpacked* and pick the `extension` folder. Its toolbar popup shows the cookie header (httpOnly cookies
included), the user agent and — once you have run a job search on Upwork with it installed — the Authorization header
of the `userJobSearch` request, each with a *Copy* button, and *Refresh* reads them again (after logging in or opening an Upwork page with the
popup open); *Send connection* saves all three to the tracker (default
`http://localhost:3000`; enter the password if the tracker uses `APP_PASSWORD`). Other addresses ask for permission
the first time. Turn on *Check Upwork through this browser* too: see [Checking through the browser](#checking-through-the-browser).

The API token (`oauth2v2_…` cookies) and organization (`current_organization_uid`) are read from the cookies.
Optionally paste the `Authorization` header of a `/api/graphql/v1?alias=userJobSearch` request too; it is tried first.
Saved values are never sent back to the page. When the Activity Log reports that you are not logged in, the token
was rejected or the security check blocked the request, copy fresh cookies the same way.

### Checking through the browser

Upwork sits behind Cloudflare, which blocks requests from the server outright ("Sorry, you have been blocked"),
whatever cookies they carry: it recognizes that they don't come from a browser. Turn on *Check Upwork through this
browser* in the extension's popup, and the extension makes the tracker's Upwork requests from the browser instead:

- It long-polls the tracker (`relayNext`) for the next request, makes it, and sends Upwork's answer back
  (`relayResult`). Each call also carries the browser's current session, so the cookies saved in the tracker stay fresh.
- A request runs inside an open upwork.com tab when there is one, exactly like Upwork's own requests; otherwise the
  extension makes it from its background worker.
- The browser has to be running. While the extension is connected, the Connection page says so. When it disconnects,
  checks fall back to the server, and Upwork blocks them.

After updating, restart the tracker (`npm start`) and reload the extension in `chrome://extensions`.

## Usage

- **Start/Stop monitoring** in the header controls checking. Monitoring continues across server restarts.
- **Job Track**: when monitoring starts, the first check loads the jobs currently matching your search filters;
  later checks add only jobs posted since (marked *Detected* with the time found). The page title shows how many new
  jobs you haven't viewed yet.
- **Prompts**: three prompt templates, saved automatically as you type: identifying who posted a job, searching
  for similar projects, and generating an email outreach message.
- **Settings → Search filters**: search keyword, job type (hourly rate range; fixed-price budget buckets or
  custom range), category, client location (regions or countries), client time zones and jobs per load (10, 20 or
  50; default 10). Results are always sorted by *Most recent*. Changes are saved automatically about a second
  after you stop editing; saving new filters loads the jobs that already match them; only newer ones count as new.
- **Settings → Monitoring**: *Upwork API* (default) sends the GraphQL search request Upwork's own search page uses
  (`/api/graphql/v1?alias=userJobSearch`). *Search page* loads the results page and reads the job tiles. Switching
  methods loads the matching jobs again.
- **Activity Log** shows every check and any errors.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `app.js`, `app.css`, `icons/` | The tracker page (Job Track, Prompts, Settings, Connection, Activity Log) |
| `filters.js` | Search filter model, Upwork search URL builder and API variables (used by the page and the server) |
| `server.js` | Serves the page, takes its commands (`POST /api/<command>`) and streams state to it (`GET /api/events`) |
| `monitor.js` | Polling timer, fetching, new-job detection, Upwork connection |
| `store.js` | State kept in memory and saved to `DATA_FILE` |
| `api.js` | GraphQL search query and conversion of API results into job objects |
| `parse-html.js` | Parses Upwork search HTML into job objects |
| `extension/` | Chrome extension that sends the Upwork session to the tracker and makes its Upwork requests from the browser (relay) |

Only the page's files are served (see `PAGE_FILES` in `server.js`); the server code and `data/` are not.
