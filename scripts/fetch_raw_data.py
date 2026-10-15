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
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlparse

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
    Source("corridor_care",
           [f"{NHSE}/uec-sitrep/",
            f"{NHSE}/uec-sitrep/urgent-and-emergency-care-daily-situation-reports-2026-27/",
            f"{NHSE}/uec-sitrep/urgent-and-emergency-care-daily-situation-reports-2025-26/"],
           follow=r"(corridor|uec-sitrep/urgent-and-emergency-care-daily-situation-reports-20(2[4-9]))",
           notes="UEC daily sitrep incl. corridor care (from March 2026) and earlier temporary escalation spaces"),
    Source("ons_projections",
           ["https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationprojections/datasets/tablea14principalprojectionenglandpopulationinagegroups",
            "https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationprojections/datasets/z1zippedpopulationprojectionsdatafilesuk"],
           depth=0, files=r"(?i)(xls|zip)",
           notes="ONS national population projections, England by age"),
    Source("ons_population",
           ["https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationestimates/datasets/populationestimatesforukenglandandwalesscotlandandnorthernireland",
            "https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationestimates/datasets/populationestimatestimeseriesdataset"],
           depth=0, files=r"(?i)(ukpopestimates|mye|pop|timeseries)",
           notes="ONS mid-year population estimates"),
]


class Fetcher:
    """Fetch pages and files.

    NHS England (AWS WAF) and NHS England Digital (Cloudflare) serve a
    JavaScript challenge to plain HTTP clients, so pages are loaded in a real
    Chromium browser (Playwright). Files are then downloaded through the same
    browser context so the challenge cookies are reused. Falls back to plain
    ``requests`` if Playwright is not installed.
    """

    def __init__(self, headless: bool = True):
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-GB,en;q=0.9",
        })
        self.pw = self.browser = self.ctx = self.page = None
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            print("Playwright not installed; using plain requests", flush=True)
            return
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(
            headless=headless, args=["--disable-blink-features=AutomationControlled"],
            executable_path=os.environ.get("CHROMIUM_PATH") or None)
        self.ctx = self.browser.new_context(user_agent=UA, locale="en-GB",
                                            accept_downloads=True,
                                            viewport={"width": 1366, "height": 900})
        self.ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        self.page = self.ctx.new_page()

    def close(self) -> None:
        if self.pw:
            self.ctx.close()
            self.browser.close()
            self.pw.stop()

    @staticmethod
    def _challenged(html: str) -> bool:
        low = html[:5000].lower()
        return ("just a moment" in low or "awswafintegration" in low
                or "challenge-platform" in low or "cf-chl" in low
                or ("<a " not in html.lower() and len(html) < 5000))

    def get_html(self, url: str) -> tuple[int, str, str]:
        if not self.page:
            r = self.s.get(url, timeout=60)
            return r.status_code, r.url, r.text
        resp = self.page.goto(url, wait_until="domcontentloaded", timeout=90_000)
        status = resp.status if resp else 0
        html = self.page.content()
        for _ in range(20):  # wait up to ~40 s for the challenge to clear
            if not self._challenged(html):
                break
            self.page.wait_for_timeout(2000)
            try:
                self.page.wait_for_load_state("domcontentloaded", timeout=10_000)
            except Exception:  # noqa: BLE001
                pass
            html = self.page.content()
            status = 200 if not self._challenged(html) else status
        return status, self.page.url, html

    def download(self, url: str, dest: Path) -> tuple[int, str] | str:
        if self.ctx:
            try:
                r = self.ctx.request.get(url, timeout=300_000)
                body = r.body()
                ctype = r.headers.get("content-type", "")
                if r.status == 200 and not ("text/html" in ctype and self._challenged(body[:5000].decode("utf-8", "ignore"))):
                    return _write(dest, body)
            except Exception:  # noqa: BLE001
                pass
            try:  # navigate so the browser solves any challenge, then catch the download
                with self.page.expect_download(timeout=180_000) as d:
                    try:
                        self.page.goto(url, timeout=180_000)
                    except Exception:  # noqa: BLE001  (navigation aborts when a download starts)
                        pass
                tmp = dest.with_suffix(dest.suffix + ".part")
                d.value.save_as(tmp)
                body = tmp.read_bytes()
                tmp.unlink()
                return _write(dest, body)
            except Exception as e:  # noqa: BLE001
                return f"browser download failed: {e}"
        with self.s.get(url, timeout=300) as r:
            if r.status_code != 200:
                return f"HTTP {r.status_code}"
            return _write(dest, r.content)


def _write(dest: Path, body: bytes) -> tuple[int, str] | str:
    if len(body) > MAX_FILE_BYTES:
        return f"too large ({len(body)} bytes)"
    if body[:15].lower().startswith((b"<!doctype html", b"<html")):
        return "got an HTML page instead of a file"
    dest.write_bytes(body)
    return len(body), hashlib.sha256(body).hexdigest()


def save_debug(url: str, status: int, final: str, html: str) -> None:
    """Keep a copy of each crawled page for diagnosis."""
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9]+", "_", urlparse(url).netloc + urlparse(url).path)[-120:]
    (DEBUG_DIR / f"{name}.html").write_text(
        f"<!-- {url}\nstatus {status} final {final} -->\n" + html[:300_000], errors="replace")


def get_links(fx: Fetcher, url: str) -> list[tuple[str, str]]:
    status, final, html = fx.get_html(url)
    save_debug(url, status, final, html)
    if Fetcher._challenged(html):
        raise RuntimeError(f"bot challenge not cleared (status {status})")
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for a in soup.find_all("a", href=True):
        href = urljoin(final, a["href"].strip())
        text = " ".join(a.get_text(" ").split())[:200]
        out.append((href.split("#")[0], text))
    return out


def safe_name(url: str) -> str:
    u = urlparse(url)
    q = parse_qs(u.query)
    path = q["uri"][0] if "uri" in q else u.path  # ONS: /file?uri=/.../name.xlsx
    name = unquote(Path(path).name) or "file"
    return re.sub(r"[^A-Za-z0-9._()+-]", "_", name)


def crawl(s: Fetcher, src: Source, log) -> list[dict]:
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
            if DATA_EXT.search(urlparse(href).path) or DATA_EXT.search(href):
                found.setdefault(href, dict(source=src.name, page=page, url=href, link_text=text))
            elif (src.follow and level[page] < src.depth and re.search(src.follow, href)
                  and href not in seen and urlparse(href).netloc == urlparse(page).netloc):
                level.setdefault(href, level[page] + 1)
                pages.append(href)
    log(f"  crawled {len(seen)} pages, {len(found)} data links")
    return list(found.values())


# ---------------------------------------------------------------- OHID Fingertips API
FINGERTIPS = "https://fingertips.phe.org.uk/api"
# Indicator names (regex, case-insensitive) for the public-health levers. England-level data,
# including deprivation-decile breakdowns where Fingertips publishes them.
FINGERTIPS_PATTERNS = {
    "smoking_prevalence": r"smoking prevalence in adults.*current smokers",
    "smoking_admissions": r"smoking attributable hospital admissions",
    "obesity_prevalence": r"(adults|aged 18).*(classified as obese|living with obesity)|obesity prevalence.*adults",
    "overweight_prevalence": r"(adults|aged 18).*overweight (or|and|including) obes",
    "obesity_admissions": r"admissions.*obesity|obesity.*admissions",
    "alcohol_admissions": r"admission episodes for alcohol.related conditions",
    "alcohol_specific": r"alcohol.specific (conditions|hospital admissions)",
    "emergency_admissions": r"emergency (hospital )?admissions (for )?(all causes|\(all|all ages)|^emergency (hospital )?admissions\s*(\(|$)",
    "flu_admissions": r"admissions.*(influenza|flu\b)|(influenza|pneumonia).*admissions",
    "respiratory_admissions": r"emergency.*admissions.*respiratory",
    "inactivity": r"percentage of physically inactive adults",
    "flu_vaccination": r"population vaccination coverage.*flu.*(65|aged 65)",
    "copd_admissions": r"emergency hospital admissions for copd",
    "falls_admissions": r"emergency hospital admissions due to falls in people aged 65",
    "deprivation_score": r"deprivation score \(imd",
}


# Indicators needed for the effects analysis, fetched by ID (names found in indicator_metadata.csv).
FINGERTIPS_IDS = {
    "emergency_all_causes": 93227, "pneumonia_admissions": 93574, "respiratory_admissions": 93575,
    "readmissions_30d": 41101, "chd_admissions": 93229, "stroke_admissions": 93231, "copd_admissions_all": 93233,
    "hip_fracture_admissions": 93241, "overweight_prevalence": 93088, "obesity_qof": 94136,
    "smoking_prevalence_aps": 92443, "obesity_prevalence_adj": 93881, "flu_vaccination": 30314,
    "deprivation_score": 93553, "alcohol_admissions_narrow": 93764, "inactivity": 93015,
    "falls_admissions": 22401, "dementia_admissions": 91281,
}
FINGERTIPS_AREA_TYPES = (15, 502, 402, 102, 501, 401, 101)


def fetch_fingertips(fx: Fetcher, manifest: dict, stamp: str, log) -> None:
    out = RAW / "fingertips"
    out.mkdir(parents=True, exist_ok=True)
    meta_url = f"{FINGERTIPS}/indicator_metadata/csv/all"
    meta_path = out / "indicator_metadata.csv"
    r = fx.s.get(meta_url, timeout=300)
    if r.status_code != 200:
        log(f"  ! Fingertips metadata HTTP {r.status_code}")
        return
    meta_path.write_bytes(r.content)
    manifest[meta_url] = dict(source="fingertips", url=meta_url, page=FINGERTIPS, link_text="indicator metadata",
                              path=str(meta_path.relative_to(ROOT)), bytes=len(r.content),
                              sha256=hashlib.sha256(r.content).hexdigest(), fetched_at=stamp)
    rows = list(csv.DictReader(r.content.decode("utf-8-sig", "replace").splitlines()))
    id_col = next(c for c in rows[0] if c.lower().replace(" ", "") in ("indicatorid", "indicator_id"))
    name_col = next(c for c in rows[0] if c.lower() in ("indicator", "indicator name", "indicatorname", "name"))
    chosen = []
    for key, pat in FINGERTIPS_PATTERNS.items():
        hits = [x for x in rows if re.search(pat, x[name_col], re.I)]
        for x in hits[:8]:
            chosen.append((key, x[id_col], x[name_col]))
        log(f"  {key}: {len(hits)} matching indicators" + (f" e.g. {hits[0][id_col]} {hits[0][name_col][:80]}" if hits else ""))
    names = {x[id_col]: x[name_col] for x in rows}
    chosen += [(k, str(i), names.get(str(i), k)) for k, i in FINGERTIPS_IDS.items()]
    # England (15), upper-tier (502/402/102) and lower-tier (501/401/101) local authorities,
    # so effects can be estimated from variation between areas and over time.
    for (key, iid, name), at in [(c, a) for c in chosen for a in FINGERTIPS_AREA_TYPES]:
        url = (f"{FINGERTIPS}/all_data/csv/by_indicator_id?indicator_ids={iid}"
               f"&child_area_type_id={at}&parent_area_type_id=15")
        dest = out / f"{key}__{iid}__at{at}.csv"
        if url in manifest and dest.exists():
            continue
        rr = fx.s.get(url, timeout=300)
        time.sleep(0.3)
        if rr.status_code != 200 or len(rr.content) < 200:
            log(f"  - {iid} area type {at}: HTTP {rr.status_code}, {len(rr.content)} bytes (no data)")
            continue
        dest.write_bytes(rr.content)
        manifest[url] = dict(source="fingertips", url=url, page=FINGERTIPS, link_text=name[:200],
                             path=str(dest.relative_to(ROOT)), bytes=len(rr.content),
                             sha256=hashlib.sha256(rr.content).hexdigest(), fetched_at=stamp)
        log(f"  downloaded {iid} {name[:70]}")


MANIFEST_FIELDS = ["source", "url", "page", "link_text", "path", "bytes", "sha256", "fetched_at"]


# ---------------------------------------------------------------- HES files via data.gov.uk
# The NHS England Digital publication pages sit behind a Cloudflare challenge, but the
# files themselves are served from files.digital.nhs.uk. data.gov.uk's catalogue (CKAN)
# lists those file URLs, so we discover them there.
CKAN = "https://ckan.publishing.service.gov.uk/api/3/action"
HES_YEARS = r"(2005-06|2008-09|2010-11|2015-16|2019-20|2023-24|2024-25|0506|0809|1011|1516|1920|2324|2425)"
HES_DIRECT = [
    "https://files.digital.nhs.uk/A5/5B8474/hosp-epis-stat-admi-diag-2023-24-tab.xlsx",
]


def fetch_hes_files(fx: Fetcher, manifest: dict, stamp: str, log) -> None:
    out = RAW / "hes_files"
    out.mkdir(parents=True, exist_ok=True)
    urls = {u: "direct" for u in HES_DIRECT}
    for q in ["hospital episode statistics admitted patient care", "hospital admitted patient care activity"]:
        r = fx.s.get(f"{CKAN}/package_search", params={"q": q, "rows": 50}, timeout=120)
        if r.status_code != 200:
            log(f"  ! CKAN search HTTP {r.status_code}")
            continue
        for pkg in r.json().get("result", {}).get("results", []):
            for res in pkg.get("resources", []):
                u = res.get("url") or ""
                if "digital.nhs.uk" in u and DATA_EXT.search(urlparse(u).path):
                    urls.setdefault(u, f"{pkg.get('name')}: {res.get('name') or ''}")
    log(f"  {len(urls)} HES file URLs found in data.gov.uk catalogue")
    inv = []
    for u, label in urls.items():
        wanted = re.search(HES_YEARS, u) and re.search(r"(?i)(hosp-epis-stat-admi|hes|apc|summ|diag|prov|age)", u)
        dest = out / safe_name(u)
        status = "skipped (year/name filter)"
        if wanted:
            if u in manifest and dest.exists():
                status = "already downloaded"
            else:
                res = fx.download(u, dest)
                if isinstance(res, tuple):
                    status = "downloaded"
                    manifest[u] = dict(source="hes_files", url=u, page="data.gov.uk catalogue", link_text=label[:200],
                                       path=str(dest.relative_to(ROOT)), bytes=res[0], sha256=res[1], fetched_at=stamp)
                else:
                    status = res
                log(f"  {status}: {u}")
        inv.append(dict(source="hes_files", page="data.gov.uk", url=u, link_text=label, wanted=bool(wanted), status=status))
    with open(out / "_link_inventory.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["source", "page", "url", "link_text", "wanted", "status"])
        w.writeheader()
        w.writerows(inv)


def write_manifest(manifest: dict) -> None:
    """Write one manifest per source (data/raw/<source>/_manifest.csv) and a combined one."""
    by_src: dict[str, list] = {}
    for r in manifest.values():
        by_src.setdefault(r["source"], []).append(r)
    for src, rows in by_src.items():
        (RAW / src).mkdir(parents=True, exist_ok=True)
        with open(RAW / src / "_manifest.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=MANIFEST_FIELDS)
            w.writeheader()
            w.writerows(sorted(rows, key=lambda r: r["path"]))
    combine_manifests()


def combine_manifests() -> None:
    rows = {}
    for p in sorted(RAW.glob("*/_manifest.csv")):
        for r in csv.DictReader(open(p)):
            rows[r["url"]] = r
    with open(RAW / "manifest.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=MANIFEST_FIELDS)
        w.writeheader()
        w.writerows(sorted(rows.values(), key=lambda r: (r["source"], r["path"])))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--headed", action="store_true", help="run Chromium with a window (use under xvfb)")
    ap.add_argument("--combine-only", action="store_true", help="just rebuild data/raw/manifest.csv")
    args = ap.parse_args()
    if args.combine_only:
        combine_manifests()
        return 0
    RAW.mkdir(parents=True, exist_ok=True)
    s = Fetcher(headless=not args.headed)
    log = lambda m: print(m, flush=True)  # noqa: E731
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    man_path, inv_path = RAW / "manifest.csv", RAW / "link_inventory.csv"
    manifest = {}
    for p in [man_path, *RAW.glob("*/_manifest.csv")]:
        if p.exists():
            for row in csv.DictReader(open(p)):
                manifest[row["url"]] = row
    inventory = []

    if not args.dry_run and (not args.only or "fingertips" in args.only):
        log("[fingertips] OHID public health indicators (risk factors, deprivation)")
        try:
            fetch_fingertips(s, manifest, stamp, log)
        except Exception as e:  # noqa: BLE001
            log(f"  ! fingertips failed: {e}")
        write_manifest(manifest)

    if not args.dry_run and (not args.only or "hes_files" in args.only):
        log("[hes_files] HES admitted patient care tables via data.gov.uk / files.digital.nhs.uk")
        try:
            fetch_hes_files(s, manifest, stamp, log)
        except Exception as e:  # noqa: BLE001
            log(f"  ! hes_files failed: {e}")
        write_manifest(manifest)

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
                        res = s.download(L["url"], dest)
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
            write_manifest(manifest)
    if args.only and len(args.only) == 1:
        inv_path = RAW / args.only[0] / "_link_inventory.csv"
        inv_path.parent.mkdir(parents=True, exist_ok=True)
    with open(inv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["source", "page", "url", "link_text", "wanted", "status"])
        w.writeheader()
        w.writerows(inventory)
    s.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
