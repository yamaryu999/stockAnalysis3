#!/usr/bin/env python3
import argparse
import math
import re
import sys
from dataclasses import dataclass
from io import BytesIO, StringIO
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd
import requests
import yfinance as yf


NIKKEI_COMPONENT_URL = "https://indexes.nikkei.co.jp/en/nkave/index/component?idx=nk225"
JPX_LIST_URL = "https://www.jpx.co.jp/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xls"



def _normalize_code(code: str) -> Optional[str]:
    code = code.strip()
    m = re.search(r"(\d{4})", code)
    if not m:
        return None
    return m.group(1)



def fetch_nikkei225_universe() -> Tuple[List[str], Dict[str, str]]:
    """Fetch Nikkei 225 tickers and names from Nikkei's official site."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        )
    }
    resp = requests.get(NIKKEI_COMPONENT_URL, headers=headers, timeout=20)
    resp.raise_for_status()
    tables = pd.read_html(StringIO(resp.text))

    tickers: List[str] = []
    name_map: Dict[str, str] = {}

    for df in tables:
        if "Code" not in df.columns or "Company Name" not in df.columns:
            continue
        for _, row in df.iterrows():
            code = row.get("Code")
            name = row.get("Company Name")
            if pd.isna(code) or pd.isna(name):
                continue
            normalized = _normalize_code(str(code))
            if not normalized:
                continue
            ticker = f"{normalized}.T"
            if ticker in name_map:
                continue
            name_map[ticker] = str(name)
            tickers.append(ticker)

    return tickers, name_map



def fetch_prime_universe() -> Tuple[List[str], Dict[str, str]]:
    """Fetch Tokyo Stock Exchange Prime Market tickers."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        )
    }
    resp = requests.get(JPX_LIST_URL, headers=headers, timeout=30)
    resp.raise_for_status()
    df = pd.read_excel(BytesIO(resp.content), engine="xlrd")

    prime_mask = df["Section/Products"].astype(str).str.contains("Prime Market", na=False)
    prime_df = df[prime_mask]

    tickers: List[str] = []
    name_map: Dict[str, str] = {}

    for _, row in prime_df.iterrows():
        code = row.get("Local Code")
        name = row.get("Name (English)")
        if pd.isna(code) or pd.isna(name):
            continue
        normalized = _normalize_code(str(code))
        if not normalized:
            continue
        ticker = f"{normalized}.T"
        if ticker in name_map:
            continue
        name_map[ticker] = str(name)
        tickers.append(ticker)

    return tickers, name_map



def chunked(seq: List[str], size: int) -> Iterable[List[str]]:
    if size <= 0:
        raise ValueError("chunk_size must be positive")
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


@dataclass
class Metrics:
    ticker: str
    name: str
    last_close: float
    ret_5: float
    ret_20: float
    ret_60: float
    ret_120: float
    ret_250: float
    above_ma20: bool
    above_ma50: bool
    above_ma200: bool
    ma200_slope_20d: float
    prox_20h: float
    prox_52wh: float
    vol_ratio_10_20: float


def _safe_pct(a: pd.Series, n: int) -> float:
    try:
        if len(a) <= n:
            return np.nan
        old = a.iloc[-(n + 1)]
        new = a.iloc[-1]
        if old == 0 or np.isnan(old) or np.isnan(new):
            return np.nan
        return (new / old) - 1.0
    except Exception:
        return np.nan


def compute_metrics_for_ticker(df: pd.DataFrame, ticker: str, name: str) -> Optional[Metrics]:
    try:
        if isinstance(df.columns, pd.MultiIndex):
            if ticker not in df.columns.get_level_values(0):
                return None
            sub = df[ticker].copy()
        else:
            # Single ticker result
            sub = df.copy()

        # Require basic columns
        required = ["Close", "High", "Volume"]
        if not all(col in sub.columns for col in required):
            return None

        close = sub["Close"].dropna()
        high = sub["High"].dropna()
        vol = sub["Volume"].fillna(0)

        if len(close) < 250:
            return None

        last_close = float(close.iloc[-1])
        ma20 = close.rolling(20).mean()
        ma50 = close.rolling(50).mean()
        ma200 = close.rolling(200).mean()

        above_ma20 = bool(last_close > float(ma20.iloc[-1]))
        above_ma50 = bool(last_close > float(ma50.iloc[-1]))
        above_ma200 = bool(last_close > float(ma200.iloc[-1]))

        ret_5 = _safe_pct(close, 5)
        ret_20 = _safe_pct(close, 20)
        ret_60 = _safe_pct(close, 60)
        ret_120 = _safe_pct(close, 120)
        ret_250 = _safe_pct(close, 250) if len(close) > 250 else np.nan

        # 20d high proximity
        high20 = float(high.rolling(20).max().iloc[-1])
        prox_20h = last_close / high20 if high20 > 0 else np.nan

        # 52w high proximity
        window_252 = min(252, len(high))
        high252 = float(high.tail(window_252).max())
        prox_52wh = last_close / high252 if high252 > 0 else np.nan

        # Volume ratio (10d vs 20d)
        v10 = float(vol.tail(10).mean())
        v20 = float(vol.tail(20).mean())
        vol_ratio = (v10 / v20) if v20 > 0 else np.nan

        # MA200 slope over ~1 month (20 trading days)
        if len(ma200.dropna()) >= 21:
            ma200_slope = (ma200.iloc[-1] / ma200.iloc[-21]) - 1.0
        else:
            ma200_slope = np.nan

        return Metrics(
            ticker=ticker,
            name=name,
            last_close=last_close,
            ret_5=ret_5,
            ret_20=ret_20,
            ret_60=ret_60,
            ret_120=ret_120,
            ret_250=ret_250,
            above_ma20=above_ma20,
            above_ma50=above_ma50,
            above_ma200=above_ma200,
            ma200_slope_20d=ma200_slope,
            prox_20h=prox_20h,
            prox_52wh=prox_52wh,
            vol_ratio_10_20=vol_ratio,
        )
    except Exception:
        return None


def download_ohlcv(tickers: List[str], chunk_size: int = 150) -> pd.DataFrame:
    frames: List[pd.DataFrame] = []

    for subset in chunked(tickers, chunk_size):
        try:
            df = yf.download(
                tickers=subset,
                period="2y",
                interval="1d",
                auto_adjust=True,
                threads=True,
                group_by="ticker",
                progress=False,
            )
        except Exception as exc:
            print(f"Download failed for chunk {subset}: {exc}", file=sys.stderr)
            continue

        if df.empty:
            continue

        if not isinstance(df.columns, pd.MultiIndex):
            # Single ticker response lacks leading level; add it back
            df.columns = pd.MultiIndex.from_product([ [subset[0]], df.columns ])
        frames.append(df)

    if not frames:
        return pd.DataFrame()

    data = pd.concat(frames, axis=1)
    data = data.loc[:, ~data.columns.duplicated()]
    data = data.sort_index(axis=1)
    return data


def screen_short(metrics: List[Metrics]) -> List[Tuple[Metrics, float]]:
    # Filters for short-term (1–4 weeks)
    filtered = [
        m for m in metrics
        if m is not None
        and m.above_ma20 and m.above_ma50
        and (not math.isnan(m.prox_20h) and m.prox_20h >= 0.97)
        and (not math.isnan(m.vol_ratio_10_20) and m.vol_ratio_10_20 >= 0.9)
    ]
    # Score emphasizing recent momentum and breakout proximity
    out = []
    for m in filtered:
        r5 = 0.0 if math.isnan(m.ret_5) else m.ret_5
        r20 = 0.0 if math.isnan(m.ret_20) else m.ret_20
        prox20 = 0.0 if math.isnan(m.prox_20h) else (m.prox_20h - 0.95)
        vr = 0.0 if math.isnan(m.vol_ratio_10_20) else min(m.vol_ratio_10_20, 2.0) - 1.0
        score = (r5 * 100.0) + (r20 * 50.0) + (prox20 * 20.0) + (vr * 10.0)
        out.append((m, score))
    out.sort(key=lambda x: x[1], reverse=True)
    return out


def screen_mid(metrics: List[Metrics]) -> List[Tuple[Metrics, float]]:
    # Filters for mid-term (1–3 months)
    filtered = [
        m for m in metrics
        if m is not None
        and m.above_ma50 and m.above_ma200
        and (not math.isnan(m.ma200_slope_20d) and m.ma200_slope_20d > 0)
        and (not math.isnan(m.ret_60) and m.ret_60 > 0)
    ]
    out = []
    for m in filtered:
        r60 = 0.0 if math.isnan(m.ret_60) else m.ret_60
        r120 = 0.0 if math.isnan(m.ret_120) else m.ret_120
        prox52 = 0.0 if math.isnan(m.prox_52wh) else (m.prox_52wh - 0.9)
        slope = 0.0 if math.isnan(m.ma200_slope_20d) else m.ma200_slope_20d
        score = (r60 * 100.0) + (r120 * 50.0) + (prox52 * 15.0) + (slope * 30.0)
        out.append((m, score))
    out.sort(key=lambda x: x[1], reverse=True)
    return out


def screen_long(metrics: List[Metrics]) -> List[Tuple[Metrics, float]]:
    # Filters for long-term (6–24 months)
    filtered = [
        m for m in metrics
        if m is not None
        and m.above_ma200
        and (not math.isnan(m.ma200_slope_20d) and m.ma200_slope_20d > 0)
        and (not math.isnan(m.ret_250) and m.ret_250 > 0)
    ]
    out = []
    for m in filtered:
        r250 = 0.0 if math.isnan(m.ret_250) else m.ret_250
        slope = 0.0 if math.isnan(m.ma200_slope_20d) else m.ma200_slope_20d
        prox52 = 0.0 if math.isnan(m.prox_52wh) else (m.prox_52wh - 0.9)
        score = (r250 * 80.0) + (slope * 40.0) + (prox52 * 20.0)
        out.append((m, score))
    out.sort(key=lambda x: x[1], reverse=True)
    return out


def format_pct(x: float) -> str:
    if x is None or math.isnan(x):
        return "-"
    return f"{x*100:.1f}%"


def main():
    parser = argparse.ArgumentParser(description="Screen Japanese equities across time horizons.")
    parser.add_argument(
        "--universe",
        choices=["nikkei225", "prime"],
        default="nikkei225",
        help="Universe to screen (nikkei225 or prime).",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=10,
        help="Number of names to list per timeframe (default: 10).",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=150,
        help="Ticker batch size per Yahoo Finance request (default: 150).",
    )
    args = parser.parse_args()

    if args.universe == "prime":
        tickers, name_map = fetch_prime_universe()
        universe_label = "TSE Prime"
    else:
        tickers, name_map = fetch_nikkei225_universe()
        universe_label = "Nikkei 225"

    tickers = [t for t in tickers if t]
    print(f"Universe: {len(tickers)} tickers ({universe_label})")

    data = download_ohlcv(tickers, chunk_size=args.chunk_size)
    if data.empty:
        print("No price data downloaded; aborting.")
        return

    metrics: List[Metrics] = []
    for t in tickers:
        m = compute_metrics_for_ticker(data, t, name_map.get(t, t))
        if m is not None:
            metrics.append(m)

    print(f"Computed metrics for: {len(metrics)} tickers")
    if not metrics:
        print("No securities passed the data sufficiency filters.")
        return

    top_n = max(args.top, 0)
    short = screen_short(metrics)[:top_n]
    mid = screen_mid(metrics)[:top_n]
    long = screen_long(metrics)[:top_n]

    def explain(m: Metrics, tf: str) -> str:
        parts: List[str] = []
        # 共通: パフォーマンスと出来高
        if not math.isnan(m.ret_5):
            parts.append(f"直近5日 {format_pct(m.ret_5)}")
        if not math.isnan(m.ret_20):
            parts.append(f"1ヶ月 {format_pct(m.ret_20)}")
        if not math.isnan(m.ret_60):
            parts.append(f"3ヶ月 {format_pct(m.ret_60)}")
        if not math.isnan(m.ret_120):
            parts.append(f"6ヶ月 {format_pct(m.ret_120)}")
        if not math.isnan(m.vol_ratio_10_20):
            parts.append(f"出来高10/20日比 {m.vol_ratio_10_20:.2f}倍")

        # 高値接近度
        if not math.isnan(m.prox_20h):
            if m.prox_20h >= 0.99:
                parts.append("20日高値圏(±1%)")
            else:
                parts.append(f"20日高値まであと {(1-m.prox_20h)*100:.1f}%")
        if not math.isnan(m.prox_52wh):
            if m.prox_52wh >= 1.0:
                parts.append("52週高値更新")
            elif m.prox_52wh >= 0.97:
                parts.append("52週高値圏(±3%)")
            else:
                parts.append(f"52週高値まであと {(1-m.prox_52wh)*100:.1f}%")

        # トレンド条件
        if tf == "short":
            if m.above_ma20 and m.above_ma50:
                parts.append("20/50日線上")
        elif tf == "mid":
            if m.above_ma50 and m.above_ma200:
                parts.append("50/200日線上")
            if not math.isnan(m.ma200_slope_20d) and m.ma200_slope_20d > 0:
                parts.append(f"200日線上向き({m.ma200_slope_20d*100:.1f}%/20日)")
        elif tf == "long":
            if m.above_ma200:
                parts.append("200日線上")
            if not math.isnan(m.ma200_slope_20d) and m.ma200_slope_20d > 0:
                parts.append(f"200日線上向き({m.ma200_slope_20d*100:.1f}%/20日)")
            if not math.isnan(m.ret_250):
                parts.append(f"12ヶ月 {format_pct(m.ret_250)}")

        return "、".join(parts)

    def print_list(title: str, lst: List[Tuple[Metrics, float]]):
        print(f"\n{title}")
        print("ticker | name | 5d | 1m | 3m | 6m | 52w% | vol10/20 | note")
        if not lst:
            print("(no candidates)")
            return
        for m, score in lst:
            note_parts = []
            if not math.isnan(m.prox_20h) and m.prox_20h >= 0.99:
                note_parts.append("near-20d-high")
            if not math.isnan(m.prox_52wh) and m.prox_52wh >= 0.99:
                note_parts.append("near-52w-high")
            if not math.isnan(m.vol_ratio_10_20) and m.vol_ratio_10_20 >= 1.1:
                note_parts.append("vol↑")
            note = ",".join(note_parts)
            prox52_delta = m.prox_52wh - 1 if not math.isnan(m.prox_52wh) else np.nan
            print(
                f"{m.ticker} | {m.name} | "
                f"{format_pct(m.ret_5)} | {format_pct(m.ret_20)} | {format_pct(m.ret_60)} | {format_pct(m.ret_120)} | "
                f"{format_pct(prox52_delta)} | "
                f"{m.vol_ratio_10_20:.2f} | {note}"
            )
            # 選定根拠を追記
            print("  根拠: " + explain(m, "short" if title.startswith("Short-term") else ("mid" if title.startswith("Mid-term") else "long")))

    print_list("Short-term candidates (1–4 weeks):", short)
    print_list("Mid-term candidates (1–3 months):", mid)
    print_list("Long-term candidates (6–24 months):", long)


if __name__ == "__main__":
    main()
