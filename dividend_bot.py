import os
import json
import re
import hashlib
import requests
import schedule
import time
import logging
import sys
from datetime import datetime, date, timedelta
from telegram import Bot
import asyncio

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(message)s")
logger = logging.getLogger(__name__)

# ─── CONFIG (override via environment variables) ─────────────────────────────
def _env_float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))

def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))

def _env_bool(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

MIN_PERCENT_GAIN = _env_float("MIN_PERCENT_GAIN", 0.2)
LOOKBACK_DAYS = _env_int("LOOKBACK_DAYS", 1)
POLL_MINUTES = _env_int("POLL_MINUTES", 30)

ALERT_DIVIDENDS = _env_bool("ALERT_DIVIDENDS", True)
ALERT_OTHER_CA = _env_bool("ALERT_OTHER_CA", True)

DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
ALREADY_SENT_FILE = os.path.join(DATA_DIR, "sent_corporate_actions.json")
# ──────────────────────────────────────────────────────────────────────────────

CA_KEYWORDS = (
    "dividend",
    "bonus",
    "stock split",
    "split",
    "buy back",
    "buyback",
    "rights issue",
    "rights",
    "amalgamation",
    "merger",
    "demerger",
    "book closure",
    "corporate action",
    "agm",
    "egm",
)

NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Referer": "https://www.nseindia.com/",
    "Connection": "keep-alive",
}

NSE_ANN_HEADERS = {
    **NSE_HEADERS,
    "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-announcements",
}


def get_nse_session(for_announcements=False):
    session = requests.Session()
    headers = NSE_ANN_HEADERS if for_announcements else NSE_HEADERS
    try:
        url = (
            "https://www.nseindia.com/companies-listing/corporate-filings-announcements"
            if for_announcements
            else "https://www.nseindia.com"
        )
        session.get(url, headers=headers, timeout=15)
        time.sleep(0.5)
    except Exception as e:
        logger.warning(f"NSE session init warning: {e}")
    return session


def parse_date_str(value: str):
    if not value or str(value).strip() in ("-", ""):
        return None
    s = str(value).strip()
    for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y", "%d %b %Y", "%Y%m%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def is_corporate_action_text(text: str) -> bool:
    t = (text or "").lower()
    return any(k in t for k in CA_KEYWORDS)


def classify_action(text: str) -> str:
    t = (text or "").lower()
    if "dividend" in t:
        return "dividend"
    if "bonus" in t:
        return "bonus"
    if "split" in t:
        return "split"
    if "buy back" in t or "buyback" in t:
        return "buyback"
    if "rights" in t:
        return "rights"
    if "merger" in t or "amalgamation" in t or "demerger" in t:
        return "merger"
    if "agm" in t:
        return "agm"
    if "egm" in t:
        return "egm"
    if "book closure" in t:
        return "book_closure"
    return "other"


def make_dedup_key(item: dict) -> str:
    raw = f"{item['exchange']}|{item['symbol'].upper()}|{item['action_type']}|{item.get('ex_date', '')}|{item['raw_subject']}"
    digest = hashlib.md5(raw.encode()).hexdigest()[:12]
    return f"{item['symbol'].upper()}_{digest}"


def parse_dividend_amount(subject: str) -> float:
    s = subject.upper()
    patterns = [
        r"RS\.?\s*-?\s*([\d,]+\.?\d*)",
        r"INR\.?\s*-?\s*([\d,]+\.?\d*)",
        r"₹\s*([\d,]+\.?\d*)",
        r"@\s*RS\.?\s*([\d,]+\.?\d*)",
        r"([\d,]+\.?\d*)\s*PER\s*(?:SHARE|EQUITY)",
        r"DIVIDEND\s*(?:OF\s*)?RS\.?\s*([\d,]+\.?\d*)",
    ]
    for pattern in patterns:
        match = re.search(pattern, s)
        if match:
            try:
                return float(match.group(1).replace(",", ""))
            except ValueError:
                continue
    return 0.0


def announcement_window():
    end = date.today()
    start = end - timedelta(days=max(LOOKBACK_DAYS - 1, 0))
    return start, end


def fetch_nse_corporate_actions(session, start: date, end: date):
    """NSE calendar API — date range is by ex-date (used to enrich dividend amounts)."""
    try:
        fd = start.strftime("%d-%m-%Y")
        td = end.strftime("%d-%m-%Y")
        url = (
            f"https://www.nseindia.com/api/corporates-corporateActions"
            f"?index=equities&from_date={fd}&to_date={td}"
        )
        resp = session.get(url, headers=NSE_HEADERS, timeout=15)
        if resp.status_code != 200:
            return []
        raw = resp.json()
        items = raw if isinstance(raw, list) else raw.get("data", [])
        by_symbol = {}
        for item in items:
            sym = (item.get("symbol") or "").upper()
            if sym:
                by_symbol.setdefault(sym, []).append(item)
        return by_symbol
    except Exception as e:
        logger.error(f"NSE corporate-actions fetch error: {e}")
        return {}


def fetch_nse_announcements(session, start: date, end: date):
    """NSE filings announced in the date window."""
    try:
        fd = start.strftime("%d-%m-%Y")
        td = end.strftime("%d-%m-%Y")
        url = (
            f"https://www.nseindia.com/api/corporate-announcements"
            f"?index=equities&from_date={fd}&to_date={td}"
        )
        resp = session.get(url, headers=NSE_ANN_HEADERS, timeout=30)
        logger.info(f"NSE announcements: {resp.status_code}, {len(resp.text)} bytes")
        if resp.status_code != 200:
            return []
        try:
            raw = resp.json()
        except json.JSONDecodeError:
            logger.error("NSE announcements returned non-JSON")
            return []

        items = raw if isinstance(raw, list) else raw.get("data", [])
        results = []
        for item in items:
            desc = item.get("desc") or item.get("subject") or ""
            if not is_corporate_action_text(desc):
                continue
            symbol = item.get("symbol") or ""
            results.append({
                "exchange": "NSE",
                "symbol": symbol,
                "company": item.get("sm_name") or symbol,
                "action_type": classify_action(desc),
                "dividend": parse_dividend_amount(desc) if "dividend" in desc.lower() else 0.0,
                "ex_date": "",
                "record_date": "",
                "announced_at": item.get("an_dt") or item.get("sort_date") or "",
                "raw_subject": desc,
                "source": "announcement",
                "seq_id": str(item.get("seq_id") or ""),
            })
        logger.info(f"NSE: {len(results)} corporate-action announcement(s) in window")
        return results
    except Exception as e:
        logger.error(f"NSE announcements fetch error: {e}")
        return []


def enrich_nse_from_calendar(announcements, calendar_by_symbol):
    for ann in announcements:
        if ann["action_type"] != "dividend":
            continue
        entries = calendar_by_symbol.get(ann["symbol"].upper(), [])
        for entry in entries:
            subject = entry.get("subject") or ""
            if "dividend" not in subject.lower():
                continue
            amt = parse_dividend_amount(subject)
            if amt > 0:
                ann["dividend"] = amt
            ann["ex_date"] = entry.get("exDate") or ann["ex_date"]
            ann["record_date"] = entry.get("recDate") or ann["record_date"]
            if not ann["raw_subject"] or len(subject) > len(ann["raw_subject"]):
                ann["raw_subject"] = subject
            break


def fetch_bse_corporate_actions(start: date, end: date):
    """BSE feed for corporate actions listed in the date window (announcement proxy)."""
    try:
        fd = start.strftime("%Y%m%d")
        td = end.strftime("%Y%m%d")
        url = (
            f"https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w"
            f"?strdate={fd}&enddate={td}&ddlcategorys=&ddlindustrys=&scripcode=&type=C"
        )
        headers = {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://www.bseindia.com/",
            "Accept": "application/json",
        }
        resp = requests.get(url, headers=headers, timeout=45)
        logger.info(f"BSE: {resp.status_code}, {len(resp.text)} bytes")
        if resp.status_code != 200:
            return []

        raw = resp.json()
        items = raw if isinstance(raw, list) else raw.get("Table", raw.get("data", []))

        results = []
        for item in items:
            subject = item.get("Purpose") or item.get("Remarks") or ""
            if not is_corporate_action_text(subject):
                continue
            symbol = item.get("short_name") or str(item.get("scrip_code") or "")
            ex_date = item.get("Ex_date") or item.get("exdate") or ""
            results.append({
                "exchange": "BSE",
                "symbol": symbol,
                "company": item.get("long_name") or item.get("LONG_NAME") or symbol,
                "action_type": classify_action(subject),
                "dividend": parse_dividend_amount(subject),
                "ex_date": ex_date,
                "record_date": item.get("RD_Date") or "",
                "announced_at": end.strftime("%d-%b-%Y"),
                "raw_subject": subject,
                "source": "corporate_action",
                "seq_id": f"{item.get('scrip_code')}_{ex_date}_{subject[:40]}",
            })
        logger.info(f"BSE: {len(results)} corporate action(s) in announcement window")
        return results
    except Exception as e:
        logger.error(f"BSE fetch error: {e}")
        return []


def get_cmp(symbol: str, exchange: str, nse_session=None) -> float:
    symbol = str(symbol).strip().upper()
    if not symbol:
        return 0.0
    suffix = ".NS" if exchange == "NSE" else ".BO"
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}{suffix}"
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        price = resp.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]
        if price:
            return float(price)
    except Exception as e:
        logger.warning(f"Yahoo CMP failed for {symbol}{suffix}: {e}")

    if exchange == "NSE" and nse_session:
        try:
            url = f"https://www.nseindia.com/api/quote-equity?symbol={symbol}"
            resp = nse_session.get(
                url,
                headers={**NSE_HEADERS, "Referer": "https://www.nseindia.com/get-quotes/equity"},
                timeout=10,
            )
            price = resp.json().get("priceInfo", {}).get("lastPrice", 0)
            if price:
                return float(price)
        except Exception:
            pass
    return 0.0


def load_sent():
    if os.path.exists(ALREADY_SENT_FILE):
        with open(ALREADY_SENT_FILE) as f:
            return json.load(f)
    legacy = "sent_dividends.json"
    if os.path.exists(legacy):
        with open(legacy) as f:
            return json.load(f)
    return {}


def save_sent(sent: dict):
    with open(ALREADY_SENT_FILE, "w") as f:
        json.dump(sent, f, indent=2)


async def send_telegram(message: str):
    bot = Bot(token=TELEGRAM_TOKEN)
    try:
        await bot.send_message(chat_id=TELEGRAM_CHAT_ID, text=message, parse_mode="Markdown")
    except Exception as e:
        logger.error(f"Telegram send failed: {e}")
        raise


def _escape_md(text: str) -> str:
    for ch in ("_", "*", "[", "]", "(", ")"):
        text = text.replace(ch, f"\\{ch}")
    return text


def build_alert(item: dict, cmp: float = 0.0, pct: float = 0.0) -> str:
    action = item["action_type"].replace("_", " ").title()
    lines = [
        f"🔔 *New Corporate Action — {item['exchange']}*",
        "",
        f"📌 *Type:* {action}",
        f"🏢 *Company:* {_escape_md(item['company'])}",
        f"📊 *Symbol:* `{item['symbol']}`",
    ]
    if item["action_type"] == "dividend" and item["dividend"] > 0:
        lines.append(f"💰 *Dividend:* ₹{item['dividend']:.2f} per share")
        if cmp > 0:
            lines.append(f"📈 *CMP:* ₹{cmp:.2f}")
            lines.append(f"🎯 *Yield:* *{pct:.2f}%*")
    if item.get("announced_at"):
        lines.append(f"📢 *Announced:* {item['announced_at']}")
    if item.get("ex_date"):
        lines.append(f"📅 *Ex-Date:* {item['ex_date']}")
    if item.get("record_date"):
        lines.append(f"📅 *Record Date:* {item['record_date']}")
    lines.append(f"🔍 *Details:* {_escape_md(item['raw_subject'][:200])}")
    return "\n".join(lines)


def should_alert(item: dict, cmp: float) -> tuple[bool, float]:
    if item["action_type"] == "dividend":
        if not ALERT_DIVIDENDS:
            return False, 0.0
        if item["dividend"] <= 0:
            logger.info(f"Skip {item['symbol']}: dividend amount unknown — {item['raw_subject'][:60]}")
            return False, 0.0
        if cmp <= 0:
            return False, 0.0
        pct = (item["dividend"] / cmp) * 100
        return pct >= MIN_PERCENT_GAIN, pct
    return ALERT_OTHER_CA, 0.0


def check_corporate_actions():
    logger.info("── Checking new corporate action announcements ──")
    sent = load_sent()
    start, end = announcement_window()
    logger.info(f"Announcement window: {start} → {end}")

    nse_session = get_nse_session(for_announcements=True)
    nse_ann = fetch_nse_announcements(nse_session, start, end)

    cal_end = end + timedelta(days=120)
    calendar = fetch_nse_corporate_actions(nse_session, end, cal_end)
    enrich_nse_from_calendar(nse_ann, calendar)

    bse_items = fetch_bse_corporate_actions(start, end)
    all_items = nse_ann + bse_items
    logger.info(f"Total new candidates in window: {len(all_items)}")

    alerts = 0
    for item in all_items:
        key = make_dedup_key(item)
        if key in sent:
            continue

        cmp = 0.0
        pct = 0.0
        if item["action_type"] == "dividend":
            cmp = get_cmp(item["symbol"], item["exchange"], nse_session)
            ok, pct = should_alert(item, cmp)
            if not ok:
                if cmp > 0 and item["dividend"] > 0:
                    logger.info(
                        f"Skip {item['symbol']}: yield {pct:.2f}% < {MIN_PERCENT_GAIN}%"
                    )
                continue
        else:
            ok, _ = should_alert(item, 0)
            if not ok:
                continue

        msg = build_alert(item, cmp, pct)
        asyncio.run(send_telegram(msg))
        sent[key] = {
            "sent_at": datetime.now().isoformat(),
            "exchange": item["exchange"],
            "action_type": item["action_type"],
            "yield": round(pct, 2) if pct else None,
            "subject": item["raw_subject"][:120],
        }
        save_sent(sent)
        alerts += 1
        logger.info(f"✅ Alert: {item['exchange']} {item['symbol']} ({item['action_type']})")
        time.sleep(1)

    logger.info(f"── Done. {alerts} alert(s) sent ──\n")


def bootstrap_seen():
    """Mark everything in the current window as seen (no Telegram messages)."""
    start, end = announcement_window()
    nse_session = get_nse_session(for_announcements=True)
    nse_ann = fetch_nse_announcements(nse_session, start, end)
    bse_items = fetch_bse_corporate_actions(start, end)
    sent = load_sent()
    for item in nse_ann + bse_items:
        sent[make_dedup_key(item)] = {"bootstrapped_at": datetime.now().isoformat()}
    save_sent(sent)
    logger.info(f"Bootstrap complete — marked {len(nse_ann) + len(bse_items)} items as seen")


def validate_config():
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        logger.error("Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID environment variables.")
        sys.exit(1)


if __name__ == "__main__":
    validate_config()
    logger.info("Corporate Action Alert Bot started.")

    if "--bootstrap" in sys.argv:
        bootstrap_seen()
    elif "--once" in sys.argv:
        check_corporate_actions()
    else:
        check_corporate_actions()
        schedule.every(POLL_MINUTES).minutes.do(check_corporate_actions)
        while True:
            schedule.run_pending()
            time.sleep(60)
