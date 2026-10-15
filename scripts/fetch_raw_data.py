"""Download the raw public data files used by the bed model.

Crawls the NHS England / NHS England Digital / ONS publication pages listed in
SOURCES, follows links to sub-pages (e.g. one page per financial year) and
downloads the data files (xls/xlsx/csv/zip/ods) into data/raw/<source>/.

Also writes:
  data/raw/manifest.csv        one row per downloaded file (url, path, bytes, sha256)
  data/raw/link_inventory.csv  every data-file link seen, downloaded or not

Designed to run in GitHub Actions (see .github/workflows/fetch-data.yml),
because the Claude cloud environment cannot reach these hosts.

Usage: python scripts/fetch_raw_data.py [--only SOURCE ...] [--dry-run]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
MAX_FILE_BYTES = 95 * 1024 * 1024  # GitHub rejects files over 100 MB
DATA_EXT = re.compile(r"\.(xlsx?|xlsm|csv|zip|ods)(\?.*)?$", re.I)
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0.0.0 Safari/537.36")
DEBUG_DIR = RAW / "_debug"

NHSE = "https://www.england.nhs.uk/statistics/statistical-work-areas"
NHSD = "https://digital.nhs.uk/data-and-information/publications/statistical"


@dataclass
class Source:
    name: str
    start: list[str]
    follow: str | None = None      # regex: sub-page URLs to crawl (depth 1)
    files: str = ".*"              # regex: file URL/filename to download
    page_filter: str | None = None  # regex: only download files found on matching pages
    depth: int = 1
    notes: str = ""
    extra: dict = field(default_factory=dict)


SOURCES = [
    Source("kh03_overnight",
           [f"{NHSE}/bed-availability-and-occupancy/bed-data-overnight/"],
           follow=None, depth=0,
           notes="KH03 overnight beds by trust/specialty, quarterly 2010/11+, plus time series"),
    Source("kh03_main",
           [f"{NHSE}/bed-availability-and-occupancy/",
            f"{NHSE}/bed-availability-and-occupancy/bed-availability-and-occupancy-kh03/"],
           follow=r"/bed-availability-and-occupancy/(bed-availability-and-occupancy-kh03|bed-data-|beds-time|historic)",
           notes="KH03 landing pages incl. historic 1987/88-2009/10 time series"),
    Source("ga_sitreps",
           [f"{NHSE}/bed-availability-and-occupancy/critical-care-and-general-acute-beds-urgent-and-emergency-care-daily-situation-reports/"],
           follow=r"critical-care-and-general-acute-beds-urgent-and-emergency-care-daily-situation-reports",
           notes="Daily G&A beds open/occupied by trust (UEC sitreps)"),
    Source("ae_attendances",
           [f"{NHSE}/ae-waiting-times-and-activity/"],
           follow=r"ae-attendances-and-emergency-admissions-20(0\d|1\d|2\d)-\d\d",
           files=r"(?i)(time.?series|adjusted|monthly|month|ae-by-provider|csv)",
           notes="Monthly A&E attendances, emergency admissions, 12h decision-to-admit waits"),
    Source("discharge_acute",
           [f"{NHSE}/discharge-delays-acute-data/",
            f"{NHSE}/discharge-delays/acute-discharge-situation-report/"],
           follow=r"discharge-delays",
           notes="Acute discharge sitrep: no criteria to reside (Apr 2022+)"),
    Source("dtoc",
           [f"{NHSE}/delayed-transfers-of-care/"],
           follow=r"delayed-transfers-of-care",
           files=r"(?i)(time.?series|total|annual|20\d\d-\d\d)",
           notes="Delayed transfers of care (Aug 2010 - Feb 2020)"),
    Source("hes_apc",
           [f"{NHSD}/hospital-admitted-patient-care-activity",
            f"{NHSD}/hospital-admitted-patient-care-activity/2024-25",
            f"{NHSD}/hospital-admitted-patient-care-activity/2023-24",
            f"{NHSD}/hospital-admitted-patient-care-activity/2015-16",
            f"{NHSD}/hospital-admitted-patient-care-activity/2010-11",
            f"{NHSD}/hospital-episode-statistics-admitted-patient-care-england-2010-11",
            f"{NHSD}/hospital-episode-statistics-admitted-patient-care-england-2008-09",
            f"{NHSD}/hospital-episode-statistics-admitted-patient-care-england-2005-06"],
           follow=r"(hospital-admitted-patient-care-activity|hospital-episode-statistics-admitted-patient-care-england)/(2005-06|2008-09|2010-11|2015-16|2023-24|2024-25)",
           page_filter=r"(2005-06|2008-09|2010-11|2015-16|2023-24|2024-25)",
           notes="HES APC annual summary tables (admissions, LOS, bed days)"),
    Source("ons_population",
           ["https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationestimates/datasets/populationestimatesforukenglandandwalesscotlandandnorthernireland",
            "https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationestimates/datasets/populationestimatestimeseriesdataset"],
           depth=0, files=r"(?i)(ukpopestimates|mye|pop|timeseries)",
           notes="ONS mid-year population estimates"),
]


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
    })
    return s


def save_debug(url: str, r: requests.Response) -> None:
    """Keep a copy of each crawled page (status, headers, HTML) for diagnosis."""
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9]+", "_", urlparse(url).netloc + urlparse(url).path)[-120:]
    head = f"<!-- {url}\nstatus {r.status_code} final {r.url}\n{dict(r.headers)} -->\n"
    (DEBUG_DIR / f"{name}.html").write_text(head + r.text[:300_000], errors="replace")


def get_links(s: requests.Session, url: str) -> list[tuple[str, str]]:
    r = s.get(url, timeout=60)
    save_debug(url, r)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    out = []
    for a in soup.find_all("a", href=True):
        href = urljoin(r.url, a["href"].strip())
        text = " ".join(a.get_text(" ").split())[:200]
        out.append((href.split("#")[0], text))
    return out


def safe_name(url: str) -> str:
    name = unquote(Path(urlparse(url).path).name) or "file"
    return re.sub(r"[^A-Za-z0-9._()+-]", "_", name)


def download(s: requests.Session, url: str, dest: Path) -> tuple[int, str] | str:
    with s.get(url, timeout=300, stream=True) as r:
        if r.status_code != 200:
            return f"HTTP {r.status_code}"
        size = int(r.headers.get("Content-Length") or 0)
        if size > MAX_FILE_BYTES:
            return f"too large ({size} bytes)"
        h, n = hashlib.sha256(), 0
        tmp = dest.with_suffix(dest.suffix + ".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                n += len(chunk)
                if n > MAX_FILE_BYTES:
                    f.close()
                    tmp.unlink()
                    return "too large (streamed)"
                h.update(chunk)
                f.write(chunk)
        tmp.rename(dest)
        return n, h.hexdigest()


def crawl(s: requests.Session, src: Source, log) -> list[dict]:
    pages, seen, found = list(src.start), set(), {}
    level = {u: 0 for u in pages}
    while pages:
        page = pages.pop(0)
        if page in seen:
            continue
        seen.add(page)
        try:
            links = get_links(s, page)
        except Exception as e:  # noqa: BLE001
            log(f"  ! page failed {page}: {e}")
            continue
        time.sleep(0.5)
        for href, text in links:
            if DATA_EXT.search(urlparse(href).path):
                found.setdefault(href, dict(source=src.name, page=page, url=href, link_text=text))
            elif (src.follow and level[page] < src.depth and re.search(src.follow, href)
                  and href not in seen and urlparse(href).netloc == urlparse(page).netloc):
                level.setdefault(href, level[page] + 1)
                pages.append(href)
    log(f"  crawled {len(seen)} pages, {len(found)} data links")
    return list(found.values())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)
    s = session()
    log = lambda m: print(m, flush=True)  # noqa: E731
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    man_path, inv_path = RAW / "manifest.csv", RAW / "link_inventory.csv"
    manifest = {}
    if man_path.exists():
        for row in csv.DictReader(open(man_path)):
            manifest[row["url"]] = row
    inventory = []

    for src in SOURCES:
        if args.only and src.name not in args.only:
            continue
        log(f"[{src.name}] {src.notes}")
        links = crawl(s, src, log)
        out_dir = RAW / src.name
        out_dir.mkdir(exist_ok=True)
        for L in links:
            wanted = re.search(src.files, L["url"] + " " + L["link_text"]) is not None
            if src.page_filter and not re.search(src.page_filter, L["page"]):
                wanted = False
            L["wanted"] = wanted
            L["status"] = "skipped (filter)"
            if wanted:
                dest = out_dir / safe_name(L["url"])
                if L["url"] in manifest and dest.exists():
                    L["status"] = "already downloaded"
                elif args.dry_run:
                    L["status"] = "dry run"
                else:
                    try:
                        res = download(s, L["url"], dest)
                    except Exception as e:  # noqa: BLE001
                        res = f"error {e}"
                    time.sleep(0.3)
                    if isinstance(res, tuple):
                        L["status"] = "downloaded"
                        manifest[L["url"]] = dict(
                            source=src.name, url=L["url"], page=L["page"], link_text=L["link_text"],
                            path=str(dest.relative_to(ROOT)), bytes=res[0], sha256=res[1],
                            fetched_at=stamp)
                    else:
                        L["status"] = res
                        log(f"  ! {res}: {L['url']}")
            inventory.append(L)
        n_ok = sum(1 for L in links if L["status"] in ("downloaded", "already downloaded"))
        log(f"  {n_ok}/{sum(L['wanted'] for L in links)} wanted files present")

    if not args.dry_run:
        with open(man_path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["source", "url", "page", "link_text", "path",
                                              "bytes", "sha256", "fetched_at"])
            w.writeheader()
            w.writerows(sorted(manifest.values(), key=lambda r: (r["source"], r["path"])))
    with open(inv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["source", "page", "url", "link_text", "wanted", "status"])
        w.writeheader()
        w.writerows(inventory)
    return 0


if __name__ == "__main__":
    sys.exit(main())
