# The "Add service" flow, explained

This guide explains every step and field in the "Add a service" dialog of YuktiOps, in plain language, with examples. It is based on the code in:

- `frontend/src/pages/services/AddServiceDialog.jsx` (the Add dialog)
- `frontend/src/pages/services/EditServiceDialog.jsx` (the Edit dialog)
- `frontend/src/pages/services/LocalTestGuide.jsx` and `local-test-guides.js` (the "Test it locally" help)
- `backend/src/routes/services.js` and `backend/src/services/service-setup.js` (what the server does)

---

## 1. What is a "service"?

A **service** is one thing you want YuktiOps to keep an eye on and tell you about when it breaks. Examples:

- Your public website `https://shop.example.com`
- A Node API listening on port 3000
- A Postgres database on your server `db-1`
- The `nginx` program on your server
- A background program such as `php-fpm`

Each service has a **state** (for example healthy or down) that you see in the Services list. There are two ways YuktiOps can check a service, and the dialog picks the right way for you based on the type you choose:

| Way of checking | Used for | Who does the check |
|---|---|---|
| **From outside** (called a "monitor" in the code) | Website, API, TCP port on a public address | YuktiOps servers call your address from the internet. Nothing to install. |
| **From inside the host** (called an "agent" check) | TCP port on one of your hosts, nginx, Apache, MySQL, PostgreSQL, Redis, System service, Program | A small **agent** program installed on your server looks locally and reports back. |

Rule of thumb: if the thing is reachable on the public internet, YuktiOps can check it from outside. If it lives on a private server (a database, a local status page, a process), an agent on that server must check it.

---

## 2. Overview of the flow

1. Click **Add a service**. (Only owners and admins can. Others see: "Only owners and admins can add services. Ask one of them to do this.")
2. **Pick a type** from 10 cards.
3. **Fill the form.** Which fields appear depends on the type. (Optional) open the **Test it locally** help to confirm it works by hand first.
4. Click **Add service**.
5. A **waiting screen** appears ("Waiting for first result...") until the first check result arrives. Then you see "First result is in" with the state and an **Open it** link.

Behind the scenes:

- **Outside checks:** the server creates a monitor, checks every 5 minutes or your plan's minimum (whichever is larger), and runs the first check right away ("in a few seconds").
- **Inside checks:** the server adds one line to the chosen host's agent settings. The agent downloads its settings regularly and starts checking. This usually takes **up to about a minute**.

---

## 3. Step 1: choose the type

| Type | Card text | Checked | Example |
|---|---|---|---|
| Website | A web page. We check it from outside. | outside | `https://shop.example.com` |
| API | An API address. We check it from outside. | outside | `https://api.example.com/health` |
| TCP port | Is a port open? Public address or on one of your hosts. | outside or on host | `db.example.com:5432`, or port 3000 on `web-1` |
| nginx | The nginx status page on a host. | on host | nginx on `web-1` |
| Apache | The Apache status page on a host. | on host | Apache on `web-1` |
| MySQL | Does MySQL answer on a host? | on host | MySQL on `db-1` |
| PostgreSQL | Does PostgreSQL answer on a host? | on host | Postgres on `db-1` |
| Redis | Does Redis answer on a host? | on host | Redis on `cache-1` |
| System service | A systemd unit such as nginx or cron. | on host | `nginx`, `cron` |
| Program | A program by its process name. | on host | `php-fpm` |

The **Back** button on the form returns to this list. The **type cannot be changed later** (see the Edit section). If you picked wrong, delete the service and add it again.

---

## 4. Step 2: the form fields

### 4.1 "Which host does it run on?" / "Where is the port?"

Shown for every type that is **not** Website or API.

- **What it is:** the server (with the YuktiOps agent installed) that will do the check. For TCP, the question is worded "Where is the port?".
- **Options in the list:**
  - Each of your hosts by name. Docker hosts show "(Docker host)".
  - **A public address (checked from outside)**: only for TCP port. Selected by default for TCP.
  - **Install the agent on that host...**: opens the agent install dialog. Use this if your server is not in the list yet. This option is not itself a host; if you submit while it is the value you get "Choose the host it runs on."
- **Default:** empty (you must choose), except TCP, which starts on "A public address".
- **Example:** your Postgres runs on a server you named `db-1`. Choose `db-1`.
- **Common mistakes:**
  - Choosing the wrong server. For example, nginx runs on `web-1` but you pick `db-1`. The check looks on `db-1` and reports it down.
  - Forgetting the agent is needed. Without an agent on the host, the list is empty and the service can never report.
  - Trying to move a service to another host later. Not allowed ("A service cannot be moved to another host. Add it there instead.").

### 4.2 Name

- **What it is:** the label shown in your list. Required, up to 100 characters.
- **Example:** "Main database", "Shop website", "Orders API".
- **Important side effects for some types:**
  - **System service:** if you leave "Unit name" empty, the name is used as the unit name. A name of `nginx` therefore watches the `nginx` unit.
  - **Program:** if you leave "Program name" empty, the name is used as the process name.
  - **Duplicates:** on the same host, you cannot add two services with the same type and the same name (case-insensitive). You get "That service is already being monitored on this host."
- **Common mistake:** calling a systemd service "My web server" and leaving Unit name empty. The agent then looks for a unit called "My web server", which does not exist. Either name it `nginx` or fill in Unit name.

### 4.3 Address (Website and API) - required

- **What it is:** the full web address to check, starting with `http://` or `https://`.
- **Examples:**
  - Website: `https://shop.example.com`
  - API: `https://api.example.com/health` (a health route is best, because it can tell you the app is actually working, not just that the server answers)
- **Rules:** the dialog says "Enter the address, starting with http." if empty. The backend rejects anything not starting with `http://` or `https://`, and it checks that the address can be resolved (it must be reachable by name from outside).
- **Common mistakes:**
  - Leaving off `https://`.
  - Using `http://localhost:3000` or an internal IP. YuktiOps checks from the internet, so it cannot see your laptop or private network. Use a public address, or use the agent route: add a **TCP port** on your host instead.
  - Checking a URL that redirects (301/302). Use the final address.
  - Pointing at a page that needs login. You will see 401/403. Use a public health route.

### 4.4 Status page address (nginx and Apache) - optional

- **What it is:** the local page where nginx/Apache publish their own numbers (connections, workers). The agent on the host fetches it.
- **Defaults:**
  - nginx: `http://127.0.0.1/nginx_status`
  - Apache: `http://127.0.0.1/server-status?auto`
- **When to fill it in:** only if you changed the location, for example `http://127.0.0.1:8080/nginx_status`.
- **Example:** nginx on `web-1` with the standard config: leave it empty. The address is checked **on that host**, so `127.0.0.1` means "that host itself".
- **Common mistakes:**
  - The status page is not turned on. nginx needs a location with `stub_status on;` (then `nginx -t && systemctl reload nginx`). Apache needs `mod_status` allowed for localhost. You will get 404 or 403.
  - Typing the public website address here. This should be the local status page, not your site.

### 4.5 Host name or IP address (TCP port on a public address)

- **Shown only** for TCP port when "A public address" is chosen. Required.
- **What it is:** the name or IP of the machine to test (no `http://`, just the host). Up to 253 characters.
- **Example:** `db.example.com` or `203.0.113.10`.
- **Common mistake:** typing `https://db.example.com`. Enter only the name.

### 4.6 Port

- **TCP port:** required. The port number to try to open, 1 to 65535. Error otherwise: "Enter a port." / "Enter a port between 1 and 65535."
- **MySQL, PostgreSQL, Redis:** optional. Defaults are **3306**, **5432**, **6379**. Leave empty unless your database uses a different port.
- **Examples:**
  - Node API on `web-1` listening on port 3000: type TCP port, host `web-1`, port `3000`.
  - Postgres running on port 5433 instead of 5432: type PostgreSQL, host `db-1`, port `5433`.
- **What a TCP check proves:** only that something accepts connections on that port. It does not prove the app behind it works.
- **Common mistakes:**
  - Entering a port that is only open inside Docker or is bound to `127.0.0.1` while checking a public address. Public checks come from outside, so the port must be reachable from the internet (firewall open).
  - Entering a text like `3000/tcp`. Numbers only.

### 4.7 Unit name (System service) - optional

- **What it is:** the exact systemd unit name, without `.service`.
- **Default:** the Name field value.
- **Example:** Name "Web server", Unit name `nginx`. Or Name `cron` with Unit empty.
- **Find the exact name:** `systemctl list-units --type=service --state=running`.
- **Common mistake:** including `.service` or using a different spelling. `apache2` on Debian/Ubuntu is `httpd` on CentOS/RHEL.

### 4.8 Program name (Program) - optional

- **What it is:** the process name, not a folder or command line.
- **Default:** the Name field value.
- **Example:** `php-fpm`, `node`, `redis-server`.
- **Check it:** `pgrep -a php-fpm` should print at least one line.
- **Common mistake:** using the full path (`/usr/sbin/php-fpm8.2`) or a name that does not match the real process name. Use the process name that `pgrep` finds.

### 4.9 "Test it locally" (collapsible help)

- **What it is:** a closed box under the form. Click to open. It gives copy-paste commands to test the service by hand, and shows what "healthy" output looks like. It changes with the type you picked. It does not add anything or send anything.
- **When to use:** before adding, if you are not sure the thing is reachable. If the command fails by hand, YuktiOps will fail too.
- **Per type:**
  - **Website:** `curl -I https://your-site.example.com`, expect `HTTP/2 200`. A second command measures time; expect `status=200` and under about 1 second. Windows: use `curl.exe` and `NUL`.
  - **API:** `curl -i https://api.example.com/health` expects 200 and a small body like `{"status":"ok"}`. A second example sends a POST with a bearer token and JSON body.
  - **TCP:** `nc -zv host 5432` (Linux/macOS) or `Test-NetConnection host -Port 5432` (Windows PowerShell). Healthy: "succeeded" or `TcpTestSucceeded : True`.
  - **nginx:** `systemctl status nginx --no-pager`, then `curl http://127.0.0.1/nginx_status` should start with `Active connections: N`.
  - **Apache:** `systemctl status apache2 --no-pager`, then `curl "http://127.0.0.1/server-status?auto"` shows `BusyWorkers` and `IdleWorkers`.
  - **MySQL:** `mysqladmin ... ping` should say `mysqld is alive`; `mysql ... -e "SELECT 1"` shows 1.
  - **PostgreSQL:** `pg_isready -h 127.0.0.1 -p 5432` says "accepting connections"; `psql ... -c 'select 1'` shows "(1 row)".
  - **Redis:** `redis-cli -h 127.0.0.1 -p 6379 ping` should answer `PONG`. `NOAUTH` means it needs a password.
  - **System service:** `systemctl status nginx`, `systemctl is-active nginx` (expect `active`), and a list command to find names.
  - **Program:** `pgrep -a php-fpm` or `ps aux | grep [p]hp-fpm`.
- The guide file also has entries for frontend app, backend app, worker, and server. These are used elsewhere in the product (they are not in the type picker here). Names like `http`, `postgresql`, `httpd`, `program` map to the matching guide automatically.

### 4.10 The error line and buttons

- A red message appears under the form for problems (missing name, bad port, etc.), or messages returned by the server.
- **Back:** return to the type list (the form is kept, errors cleared).
- **Add service:** sends the request; shows a spinner while working.

---

## 5. Step 3: what happens after "Add service"

The server decides which way to check:

- **Website, API, or TCP with "public address":** creates an outside **monitor**.
  - Checked every **300 seconds (5 minutes)**, or your plan's minimum if that is larger.
  - Counts as down after **2 failures in a row** (so one blip does not alert you).
  - Your plan has a maximum number of monitors. If you hit it, the server refuses.
  - You will also see it under **Websites and APIs**; the waiting screen links to it.
- **Everything else:** adds an entry to the chosen host's agent settings. The agent picks it up on its next settings check (usually within a minute).
  - Type mapping: System service becomes a `systemd` entry, Program becomes `process`, TCP on a host becomes a `port` entry, others keep their type.
  - nginx/Apache get the default status address if you left it empty.

The **waiting screen** refreshes every 4 seconds. If it shows "This is taking longer than usual" (after about 80 seconds) you can close the window; it keeps trying. For agent-based services, slowness usually means the agent is not running or cannot reach YuktiOps.

---

## 6. Worked examples

**A. Node API on port 3000, public at `https://api.example.com`**
1. Type: **API**. Name: `Orders API`. Address: `https://api.example.com/health`. Add.
2. Optional second service: a **TCP port** on host `web-1`, port `3000`, to confirm the Node process itself is listening.

**B. A Postgres database on a private server `db-1`**
1. Type: **PostgreSQL**. Host: `db-1`. Name: `Main database`. Port: empty (5432) unless custom. Add.
2. Try first: `pg_isready -h 127.0.0.1 -p 5432` on `db-1`.

**C. An nginx website**
1. Public availability: type **Website**, Name `Marketing site`, Address `https://www.example.com`.
2. Server health: type **nginx**, Host `web-1`, Name `nginx on web-1`, status address empty. Needs `stub_status` enabled.
3. Process up/down: type **System service**, Host `web-1`, Name `nginx` (unit empty).

**D. A public database port**
Type **TCP port**, keep "A public address", address `db.example.com`, port `5432`. Remember this only proves the port is open from the internet.

**E. Background worker `php-fpm`**
Type **Program**, Host `web-1`, Name `php-fpm`, Program name empty (uses the name).

---

## 7. Editing a service

Open a service and choose Edit. The dialog says "Change what we watch. The type cannot be changed."

| Field | Shown for | Notes |
|---|---|---|
| Name | all | Required, up to 100 characters. For System service and Program entries the name is the unit/process, so see below. |
| Address | website, api, http, keyword, nginx, apache | Must start with http:// or https:// |
| Host name or IP address (public checks) | TCP | Used for the host to test |
| Port | TCP, MySQL, PostgreSQL, Redis | 1 to 65535 |
| Unit name | System service | Replaces the unit being watched |
| Program name | Program | Replaces the process being watched |

Things to know:
- Empty optional fields are simply not sent, so they stay as they were; you cannot clear a field by emptying it.
- **The id can change.** For host-based services, the id is built from the type and the name, so renaming gives a new id. The app uses the returned id.
- For System service/Program, the unit/process name is what changes the entry's name. Changing only "Name" on those keeps the old target and only the label may not change in the way you expect; edit Unit/Program name to change what is watched.
- You cannot move a service to another host, and you cannot send fields that do not belong to the type (error like "port cannot be changed on a systemd service").
- Changing an outside monitor's address triggers a fresh check immediately and resets certificate/domain expiry info.
- The API also accepts `intervalSeconds` (1 to 86400) and `failureThreshold` (1 to 10) for outside monitors, but the dialog does not show them. The interval cannot be shorter than your plan's minimum (error 402: "Your <plan> plan checks at most every N seconds.").
- Only owners and admins can edit or delete.

## 8. Deleting a service

Deleting removes the monitor (outside checks) or the entry from the host's agent settings (host checks), so the agent stops reporting it. History for incidents keeps the name.

---

## 9. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| "Only owners and admins can add services." | Your role | Ask an owner/admin. |
| "Give the service a name." | Empty name | Fill in Name. |
| "Choose the host it runs on." | No host chosen, or "Install the agent" selected | Pick a real host, or finish installing the agent first. |
| "Enter the address, starting with http." / "Use an http:// or https:// address." | Missing or wrong address | Include `https://`. |
| "Enter a port." / "Enter a port between 1 and 65535." | TCP without port, or bad number | Use digits 1 to 65535. |
| "That service is already being monitored on this host." (409) | Same type and name on that host already | Pick a different name or edit the existing one. |
| Host list is empty | No agent installed yet | Choose "Install the agent on that host..." and follow the steps. |
| Waiting screen never finishes (agent type) | Agent stopped, cannot reach YuktiOps, or settings not fetched yet | On the host: `systemctl status yuktiops-agent` (or `docker ps --filter name=yuktiops-agent`). Wait about a minute. |
| Waiting screen never finishes (website/API) | Check not yet run or address not reachable | Wait a few seconds, open it under Websites and APIs. |
| Website/API shows down but works in your browser | Redirect, login needed, firewall blocking YuktiOps, or only reachable inside your network | Test with `curl -I` from outside. Use the final address and a public health route. |
| nginx/Apache down or no metrics | Status page not enabled or wrong address | Enable `stub_status` / `mod_status` for 127.0.0.1, test with curl on the host. |
| MySQL/Postgres/Redis down | Wrong port, not listening, needs password, or wrong host | Run the "Test it locally" commands on the host. Redis `NOAUTH` means it needs a password. |
| System service shows stopped | Unit is inactive/failed, or wrong unit name | `systemctl is-active <unit>`; use the name without `.service`. |
| Program shows stopped | Process name does not match | `pgrep -a <name>`. |
| Error "Could not create/update/delete this service. Try again..." (500) | Unexpected server problem | Retry; if it keeps failing, contact support. Details are in the server log. |
| Plan limit message on creation | Monitor count at your plan's maximum | Remove unused monitors or upgrade. |

General tip: always test by hand first with the "Test it locally" box. If it does not work from a terminal on the right machine, it will not work in YuktiOps either.
