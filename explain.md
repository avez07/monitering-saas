# The "Add service" flow, explained

This guide explains every step and field in the "Add a service" dialog of YuktiOps, in plain language, with examples. It is based on the code in:

- `frontend/src/pages/services/AddServiceDialog.jsx` (the Add dialog)
- `frontend/src/pages/services/EditServiceDialog.jsx` (the Edit dialog)
- `frontend/src/pages/services/CredentialsSection.jsx` and `credentials-guide.js` (the optional database credentials)
- `frontend/src/pages/services/LocalTestGuide.jsx` and `local-test-guides.js` (the "Test it locally" help)
- `backend/src/routes/services.js` and `backend/src/services/service-setup.js` (what the server does)

---

## 1. What is a "service"?

A **service** is one thing running **on one of your hosts** that you want YuktiOps to keep an eye on and tell you about when it breaks. Examples:

- A Node API listening on port 3000 on `web-1`
- A Postgres or SQL Server database on your server `db-1`
- The `nginx` program on your server
- A background program such as `php-fpm`

Each service has a **state** (running, stopped, failed or unknown) that you see in the Services list. A small **agent** program installed on the host looks locally and reports back. That is why every service needs a host.

**Websites, APIs and public ports are not services.** They are checked from the internet by YuktiOps itself and live under **Websites & APIs**. The Add a service dialog links there ("Checking a website, API or public port? → Websites & APIs").

---

## 2. Overview of the flow

1. Click **Add a service**. (Only owners and admins can. Others see: "Only owners and admins can add services. Ask one of them to do this.")
2. **Pick a type** from 9 cards.
3. **Fill the form.** Which fields appear depends on the type. For databases you can optionally add **credentials** for deep metrics. (Optional) open the **Test it locally** help to confirm it works by hand first.
4. Click **Add service**.
5. A **waiting screen** appears ("Waiting for first result...") until the agent reports the service. Then you see "First result is in" with the state and an **Open it** link.

Behind the scenes the server adds one line to the chosen host's agent settings. The agent downloads its settings regularly and starts checking. This usually takes **up to about a minute**.

---

## 3. Step 1: choose the type

| Type | Card text | Example |
|---|---|---|
| TCP port | Is a port open on one of your hosts? | port 3000 on `web-1` |
| nginx | The nginx status page on a host. | nginx on `web-1` |
| Apache | The Apache status page on a host. | Apache on `web-1` |
| MySQL | Does MySQL answer on a host? | MySQL on `db-1` |
| PostgreSQL | Does PostgreSQL answer on a host? | Postgres on `db-1` |
| Microsoft SQL Server | Does SQL Server answer on a host? | SQL Server on `db-2` |
| Redis | Does Redis answer on a host? | Redis on `cache-1` |
| System service | A systemd unit such as nginx or cron. | `nginx`, `cron` |
| Program | A program by its process name. | `php-fpm` |

Under the cards: "Checking a website, API or public port? → Websites & APIs". Use that for anything reachable from the internet, such as `https://shop.example.com` or `db.example.com:5432`.

The **Back** button on the form returns to this list. The **type cannot be changed later** (see the Edit section). If you picked wrong, delete the service and add it again.

---

## 4. Step 2: the form fields

### 4.1 "Which host does it run on?" / "Which host has the port?"

Shown for every type. Required.

- **What it is:** the server (with the YuktiOps agent installed) that will do the check.
- **Options in the list:**
  - Each of your hosts by name. Docker hosts show "(Docker host)".
  - **Install the agent on that host...**: opens the agent install dialog. Use this if your server is not in the list yet. This option is not itself a host; if you submit while it is the value you get "Choose the host it runs on."
- **Example:** your Postgres runs on a server you named `db-1`. Choose `db-1`.
- **Common mistakes:**
  - Choosing the wrong server. For example, nginx runs on `web-1` but you pick `db-1`. The check looks on `db-1` and reports it down.
  - Forgetting the agent is needed. Without an agent on the host, the list is empty and the service can never report.
  - Trying to move a service to another host later. Not allowed ("A service cannot be moved to another host. Add it there instead.").
  - Sending a TCP port without a host through the API: 400 "Choose the host. For a public address use Websites & APIs."

### 4.2 Name

- **What it is:** the label shown in your list. Required, up to 100 characters.
- **Example:** "Main database", "Orders API port".
- **Important side effects for some types:**
  - **System service:** if you leave "Unit name" empty, the name is used as the unit name. A name of `nginx` therefore watches the `nginx` unit.
  - **Program:** if you leave "Program name" empty, the name is used as the process name.
  - **Duplicates:** on the same host, you cannot add two services with the same type and the same name (case-insensitive). You get "That service is already being monitored on this host."
- **Common mistake:** calling a systemd service "My web server" and leaving Unit name empty. The agent then looks for a unit called "My web server", which does not exist. Either name it `nginx` or fill in Unit name.

### 4.3 Status page address (nginx and Apache) - optional

- **What it is:** the local page where nginx/Apache publish their own numbers (connections, workers). The agent on the host fetches it.
- **Defaults:**
  - nginx: `http://127.0.0.1/nginx_status`
  - Apache: `http://127.0.0.1/server-status?auto`
- **When to fill it in:** only if you changed the location, for example `http://127.0.0.1:8080/nginx_status`.
- **Example:** nginx on `web-1` with the standard config: leave it empty. The address is checked **on that host**, so `127.0.0.1` means "that host itself".
- **Common mistakes:**
  - The status page is not turned on. nginx needs a location with `stub_status on;` (then `nginx -t && systemctl reload nginx`). Apache needs `mod_status` allowed for localhost. You will get 404 or 403.
  - Typing the public website address here. This should be the local status page, not your site. To check the site itself, use Websites & APIs.

### 4.4 Port

- **TCP port:** required. The port number to try to open on the host, 1 to 65535. Error otherwise: "Enter a port." / "Enter a port between 1 and 65535."
- **MySQL, PostgreSQL, SQL Server, Redis:** optional. Defaults are **3306**, **5432**, **1433**, **6379**. Leave empty unless your database uses a different port.
- **Examples:**
  - Node API on `web-1` listening on port 3000: type TCP port, host `web-1`, port `3000`.
  - Postgres running on port 5433 instead of 5432: type PostgreSQL, host `db-1`, port `5433`.
- **What a TCP check proves:** only that something accepts connections on that port. It does not prove the app behind it works.
- **Common mistake:** entering a text like `3000/tcp`. Numbers only.

### 4.5 Unit name (System service) - optional

- **What it is:** the exact systemd unit name, without `.service`.
- **Default:** the Name field value.
- **Example:** Name "Web server", Unit name `nginx`. Or Name `cron` with Unit empty.
- **Find the exact name:** `systemctl list-units --type=service --state=running`.
- **Common mistake:** including `.service` or using a different spelling. `apache2` on Debian/Ubuntu is `httpd` on CentOS/RHEL.

### 4.6 Program name (Program) - optional

- **What it is:** the process name, not a folder or command line.
- **Default:** the Name field value.
- **Example:** `php-fpm`, `node`, `redis-server`.
- **Check it:** `pgrep -a php-fpm` should print at least one line.
- **Common mistake:** using the full path (`/usr/sbin/php-fpm8.2`) or a name that does not match the real process name. Use the process name that `pgrep` finds.

### 4.7 Credentials (optional, for deep metrics) - MySQL, PostgreSQL, SQL Server, Redis

Without credentials, the agent still checks that the database **answers** (liveness). A password-protected Redis shows "responding (password required)". With credentials, the agent also reads the database's own statistics (connections, queries, memory and so on) for the advanced dashboards.

- **Credentials name:** a short name you choose, for example `redis-main` or `sql-ro`. Up to 40 lowercase letters, digits and dashes, starting with a letter or digit. Leave it empty to skip.
- **The password stays on your server.** YuktiOps stores only the name. The agent reads the user and password on the host, so they are never sent to us. The dialog's "How to set it up" box shows the exact commands for the type you picked:
  1. **Create a read-only monitoring user** (replace PASS with a strong password):
     - Redis: `ACL SETUSER yuktiops on >PASS +ping +info +client|list`
     - MySQL: `CREATE USER 'yuktiops'@'%' IDENTIFIED BY 'PASS'; GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'yuktiops'@'%';`
     - PostgreSQL: `CREATE ROLE yuktiops LOGIN PASSWORD 'PASS'; GRANT pg_monitor TO yuktiops;`
     - SQL Server: `CREATE LOGIN yuktiops WITH PASSWORD='PASS'; GRANT VIEW SERVER STATE TO yuktiops;`
  2. **Give the agent the password**, one of:
     - Linux: the file `/etc/yuktiops/credentials.d/<name>.env` with the lines `USER=yuktiops` and `PASSWORD=PASS`, owned by the `yuktiops` user and **mode 0600**. Any looser mode and the agent refuses it ("credentials file must be 0600").
     - Windows: the same lines in `%PROGRAMDATA%\yuktiops\credentials.d\<name>.env`.
     - Docker agent (or any host): environment variables on the agent, `YUKTIOPS_CRED_<NAME>_USER` and `YUKTIOPS_CRED_<NAME>_PASSWORD`, where `<NAME>` is the name in capitals with `-` replaced by `_`. For `redis-main`: `YUKTIOPS_CRED_REDIS_MAIN_USER` and `YUKTIOPS_CRED_REDIS_MAIN_PASSWORD`.
     - Also supported: `DATABASE`, `SSLMODE`, or one full `URL` (connection string) instead of USER and PASSWORD.
  3. Within about a minute the service detail shows **authenticated**, or the reason it could not sign in: **auth failed: wrong user or password**, **credentials not found**.
- **Redis older than 6** has no users: leave USER out and set PASSWORD to the `requirepass` value.
- **Common mistakes:** a name with capitals or underscores (rejected), a file readable by other users (refused), or the file owned by root so the agent cannot read it.

### 4.8 "Test it locally" (collapsible help)

- **What it is:** a closed box under the form. Click to open. It gives copy-paste commands to test the service by hand, and shows what "healthy" output looks like. It changes with the type you picked. It does not add anything or send anything.
- **When to use:** before adding, if you are not sure the thing is reachable. If the command fails by hand, YuktiOps will fail too.
- **Per type:**
  - **TCP:** `nc -zv host 5432` (Linux/macOS) or `Test-NetConnection host -Port 5432` (Windows PowerShell). Healthy: "succeeded" or `TcpTestSucceeded : True`.
  - **nginx:** `systemctl status nginx --no-pager`, then `curl http://127.0.0.1/nginx_status` should start with `Active connections: N`.
  - **Apache:** `systemctl status apache2 --no-pager`, then `curl "http://127.0.0.1/server-status?auto"` shows `BusyWorkers` and `IdleWorkers`.
  - **MySQL:** `mysqladmin ... ping` should say `mysqld is alive`; `mysql ... -e "SELECT 1"` shows 1.
  - **PostgreSQL:** `pg_isready -h 127.0.0.1 -p 5432` says "accepting connections"; `psql ... -c 'select 1'` shows "(1 row)".
  - **SQL Server:** `nc -zv 127.0.0.1 1433` (or `Test-NetConnection 127.0.0.1 -Port 1433`), then `sqlcmd -S 127.0.0.1,1433 -U sa -Q "SELECT @@VERSION"` prints the version. "Login failed" still means it is running. A refused connection usually means TCP/IP is off in SQL Server Configuration Manager.
  - **Redis:** `redis-cli -h 127.0.0.1 -p 6379 ping` should answer `PONG`. `NOAUTH` means it needs a password.
  - **System service:** `systemctl status nginx`, `systemctl is-active nginx` (expect `active`), and a list command to find names.
  - **Program:** `pgrep -a php-fpm` or `ps aux | grep [p]hp-fpm`.
- The guide file also has entries for website, API, frontend app, backend app, worker, and server. These are used elsewhere in the product (Websites & APIs, Apps). Names like `postgresql`, `sql server`, `httpd`, `program` map to the matching guide automatically.

### 4.9 The error line and buttons

- A red message appears under the form for problems (missing name, bad port, bad credentials name, etc.), or messages returned by the server.
- **Back:** return to the type list (the form is kept, errors cleared).
- **Add service:** sends the request; shows a spinner while working.

---

## 5. Step 3: what happens after "Add service"

The server adds an entry to the chosen host's agent settings. The agent picks it up on its next settings check (usually within a minute).

- Type mapping: System service becomes a `systemd` entry, Program becomes `process`, TCP becomes a `port` entry, others keep their type (`mssql` for SQL Server).
- nginx/Apache get the default status address if you left it empty.
- Databases get their standard port if you left it empty, and keep the credentials name if you gave one.

The **waiting screen** refreshes every 4 seconds. If it shows "This is taking longer than usual" (after about 80 seconds) you can close the window; it keeps trying. Slowness usually means the agent is not running or cannot reach YuktiOps.

---

## 6. Worked examples

**A. Node API on port 3000 on `web-1`**
1. Type: **TCP port**. Host `web-1`. Name: `Orders API port`. Port `3000`. Add.
2. Its public address (`https://api.example.com/health`) is added under **Websites & APIs**, not here.

**B. A Postgres database on a private server `db-1`, with deep metrics**
1. Type: **PostgreSQL**. Host: `db-1`. Name: `Main database`. Port: empty (5432) unless custom. Credentials name: `pg-main`. Add.
2. On `db-1`: run `CREATE ROLE yuktiops LOGIN PASSWORD '...'; GRANT pg_monitor TO yuktiops;`, then create `/etc/yuktiops/credentials.d/pg-main.env` (mode 0600) as shown in the dialog.
3. Try first: `pg_isready -h 127.0.0.1 -p 5432` on `db-1`. The service soon shows "authenticated".

**C. An nginx website**
1. Public availability: under **Websites & APIs**, add `https://www.example.com`.
2. Server health: type **nginx**, Host `web-1`, Name `nginx on web-1`, status address empty. Needs `stub_status` enabled.
3. Process up/down: type **System service**, Host `web-1`, Name `nginx` (unit empty).

**D. SQL Server on a Windows host `db-2`**
Type **Microsoft SQL Server**, Host `db-2`, Name `Orders DB`, port empty (1433). For deep metrics add a credentials name such as `sql-ro`, run `CREATE LOGIN yuktiops WITH PASSWORD='...'; GRANT VIEW SERVER STATE TO yuktiops;` and put `USER=` and `PASSWORD=` lines in `%PROGRAMDATA%\yuktiops\credentials.d\sql-ro.env`.

**E. Background worker `php-fpm`**
Type **Program**, Host `web-1`, Name `php-fpm`, Program name empty (uses the name).

---

## 7. Editing a service

Open a service and choose Edit. The dialog says "Change what we watch. The type cannot be changed."

| Field | Shown for | Notes |
|---|---|---|
| Name | all | Required, up to 100 characters. For System service and Program entries the name is the unit/process, so see below. |
| Status page address | nginx, Apache | Must start with http:// or https:// |
| Address the agent connects to (optional) | TCP, MySQL, PostgreSQL, SQL Server, Redis | Leave empty for the host itself |
| Port | TCP, MySQL, PostgreSQL, SQL Server, Redis | 1 to 65535 |
| Credentials name | MySQL, PostgreSQL, SQL Server, Redis | Empty it to stop using credentials |
| Unit name | System service | Replaces the unit being watched |
| Program name | Program | Replaces the process being watched |

Things to know:
- Empty optional fields are simply not sent, so they stay as they were; you cannot clear a field by emptying it. The exception is the credentials name: emptying it removes it.
- **The id can change.** The id is built from the type and the name, so renaming gives a new id. The app uses the returned id.
- For System service/Program, the unit/process name is what changes the entry's name. Changing only "Name" on those keeps the old target and only the label may not change in the way you expect; edit Unit/Program name to change what is watched.
- You cannot move a service to another host, and you cannot send fields that do not belong to the type (error like "port cannot be changed on a systemd service").
- Only owners and admins can edit or delete.

## 8. Deleting a service

Deleting removes the entry from the host's agent settings, so the agent stops reporting it, and removes the service from your list.

---

## 9. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| "Only owners and admins can add services." | Your role | Ask an owner/admin. |
| "Give the service a name." | Empty name | Fill in Name. |
| "Choose the host it runs on." | No host chosen, or "Install the agent" selected | Pick a real host, or finish installing the agent first. |
| "Choose the host. For a public address use Websites & APIs." | A TCP port without a host (API) | Pick the host, or add the public address under Websites & APIs. |
| "Enter a port." / "Enter a port between 1 and 65535." | TCP without port, or bad number | Use digits 1 to 65535. |
| "Use up to 40 lowercase letters, digits and dashes..." | Bad credentials name | Use something like `redis-main`. |
| "That service is already being monitored on this host." (409) | Same type and name on that host already | Pick a different name or edit the existing one. |
| Host list is empty | No agent installed yet | Choose "Install the agent on that host..." and follow the steps. |
| Waiting screen never finishes | Agent stopped, cannot reach YuktiOps, or settings not fetched yet | On the host: `systemctl status yuktiops-agent` (or `docker ps --filter name=yuktiops-agent`). Wait about a minute. |
| nginx/Apache down or no metrics | Status page not enabled or wrong address | Enable `stub_status` / `mod_status` for 127.0.0.1, test with curl on the host. |
| MySQL/Postgres/SQL Server/Redis down | Wrong port, not listening, or wrong host | Run the "Test it locally" commands on the host. Redis `NOAUTH` means it needs a password, but it still counts as running. |
| Detail says "credentials not found" | No env vars or `credentials.d/<name>.env` for that name | Check the spelling of the name and the file location. Restart the Docker agent after changing its environment. |
| Detail says "credentials file must be 0600" | File readable by others | `sudo chmod 600 /etc/yuktiops/credentials.d/<name>.env` and make `yuktiops` the owner. |
| Detail says "auth failed: wrong user or password" | Wrong user, password, or missing grant | Recreate the monitoring user with the command from the dialog. |
| System service shows stopped | Unit is inactive/failed, or wrong unit name | `systemctl is-active <unit>`; use the name without `.service`. |
| Program shows stopped | Process name does not match | `pgrep -a <name>`. |
| Error "Could not create/update/delete this service. Try again..." (500) | Unexpected server problem | Retry; if it keeps failing, contact support. Details are in the server log. |

General tip: always test by hand first with the "Test it locally" box. If it does not work from a terminal on the right machine, it will not work in YuktiOps either.
