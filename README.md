# My Budget App

A self-hosted budgeting calendar. It tracks money in and out of all your accounts, projects every balance forward day by day, and warns you **in advance** when a bill is due, when an amount needs entering, or when an account will run low and you need to move money.

Nothing connects to a bank: you enter balances and schedules yourself, and all data stays in a SQLite database on your machine.

## Features

- **Calendar.** The current month opens by default; use ‹ › (or the arrow keys) to switch months. Each day lists its credits, debits and transfers and shows the projected end-of-day balance. Days where an account falls below its minimum are shaded red. Filter to a single account, or see everything at once.
- **Multiple accounts.** Checking, savings, credit cards, cash and so on, each with its own balance, color and optional low-balance warning.
- **Recurring and one-time items.** Income (credits), expenses (debits) and transfers between accounts, each assigned to an account. Repeats daily, weekly, every 2 weeks, monthly, every N months, yearly, or on a custom interval, with an optional end date.
- **Varying amounts.** For bills like credit card payments and electricity, choose "Varies each time". The app asks you for the real amount before each due date. Until you enter it, projections use your estimate, or the last amount you entered.
- **Never miss a payment.** Bills you pay by hand show up in **Needs attention** a few days ahead (you choose how many). If one passes without being marked paid, it shows as **Overdue**. Mark autopay bills as such and you won't be reminded about them.
- **Know when to move money.** If an account is projected to drop below its minimum in the next 45 days, you'll see when it happens and which bill causes it. The app suggests how much to move from which account, and by what date; one click schedules the transfer.
- **Per-occurrence changes.** Change the amount or date of a single occurrence, skip it, or mark it paid. Edits to a series can apply to all occurrences or only to "this and future" ones (for example, when rent goes up).
- **Optional daily digest.** A push notification through [ntfy](https://ntfy.sh) and/or an email, sent only on days when something needs you.
- Works on a phone, supports dark mode, and exports/imports JSON backups.

## Run it

You need [Docker](https://docs.docker.com/get-docker/) with Docker Compose.

```bash
git clone <this repo> budget && cd budget
# Set TZ in docker-compose.yml to your time zone first (e.g. America/Chicago).
docker compose up -d --build
```

Open <http://localhost:8080>. From another device on your network, use `http://<this computer's IP>:8080`.

To update after pulling new code: `docker compose up -d --build`. Your data is kept in the `budget-data` Docker volume.

> **Security:** there are no logins. Only run it on a network you trust and don't expose it to the internet. To allow only the computer running Docker, change the port line in `docker-compose.yml` to `"127.0.0.1:8080:8000"`.

## Getting started

1. **Accounts:** add each account with its current balance. For a credit card, enter what you owe as a negative number. Turn on "Warn me when this account is projected to drop below…" and set a minimum (e.g. $200 for checking).
2. **Bills & income:** click **+ Add** for each paycheck, bill and regular transfer.
   - Choose **Varies each time** for anything whose amount changes (credit cards, utilities). Add an estimate if you like.
   - Tick **Autopay** for things that pay themselves. Leave it off for bills you pay by hand, and set **Remind me N days before**.
3. **Each day:** check the **Needs attention** panel. Enter the amounts it asks for, click **Mark paid** after you pay something, and use **Schedule this transfer…** when it says to move money.
4. Whenever you look at your bank, use **Accounts → Update balance** so projections start from the real number.

### Credit cards: two ways

- **Simple:** add the card payment as an **expense** from checking with a varying amount. You're reminded to enter the statement amount and to pay it.
- **Full picture:** add the card as an account and put card spending on it. Add the payment as a **transfer** from checking to the card, with a varying amount. The card balance then shows what you owe.

### How balances are calculated

An account's balance is the amount you entered *at the start of* its "as of" date. Every item dated on or after that date is added or subtracted. Skipped occurrences don't count. Marking something paid doesn't change the projection; it records that you dealt with it and clears the reminder. When you update a balance, you can say whether today's items have already gone through.

Items dated before the day you added them are treated as history, so adding a bill that started last year won't produce a pile of "overdue" warnings.

## Daily digest (optional)

Uncomment and fill in the options in `docker-compose.yml`, then run `docker compose up -d` again:

| Variable | Purpose |
| --- | --- |
| `NOTIFY_TIME` | Time of day to send, in the container's `TZ` (default `08:00`) |
| `APP_URL` | Link to include in the notification, e.g. `http://192.168.1.50:8080` |
| `NTFY_URL` | ntfy topic URL, e.g. `https://ntfy.sh/some-long-random-topic`. Install the ntfy app on your phone and subscribe to the same topic. |
| `NTFY_TOKEN` | Access token, only for protected topics |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_TO` | Email delivery. Port 465 uses SSL; other ports use STARTTLS. For Gmail, use an [app password](https://support.google.com/accounts/answer/185833). |

**Settings → Send a test now** checks your setup. On ntfy.sh, anyone who knows a topic name can read it, so pick a long random one, or self-host ntfy.

## Backups

- **Settings → Export backup** downloads everything as JSON. **Restore from backup…** replaces all current data with a backup.
- To copy the raw database: `docker compose cp budget:/data/budget.db ./budget-backup.db`

## Development

```bash
pip install -r requirements-dev.txt
python -m pytest                                              # tests
BUDGET_DB=data/budget.db uvicorn app.main:create_app --factory --reload --port 8080
```

- `app/recurrence.py`: date math for repeating schedules
- `app/ledger.py`: expands schedules into occurrences, projects balances, builds alerts
- `app/main.py`: JSON API under `/api`; also serves the front end
- `app/notify.py`: daily digest via ntfy and SMTP
- `static/`: the front end (plain JavaScript modules, no build step)

All money is stored as integer cents.
