import express from 'express';
import morgan from 'morgan';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { DateTime } from 'luxon';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_LIMIT = 5;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0 Safari/537.36';

const defaultCandidates = [
  { code: '6098', name: 'リクルートホールディングス' },
  { code: '6857', name: 'アドバンテスト' },
  { code: '6501', name: '日立製作所' },
  { code: '6758', name: 'ソニーグループ' },
  { code: '7203', name: 'トヨタ自動車' },
  { code: '8035', name: '東京エレクトロン' },
  { code: '7974', name: '任天堂' },
  { code: '9984', name: 'ソフトバンクグループ' },
  { code: '6503', name: '三菱電機' },
  { code: '6981', name: '村田製作所' }
];

const weights = {
  Catalyst: 30,
  Momentum: 20,
  SupplyDemand: 15,
  Revisions: 15,
  Technical: 10,
  Valuation: 10
};

const keywordBuckets = {
  catalyst: ['買収', '提携', '契約', '投資', '受注', '協業', '研究開発', 'AI', '生成', '月面', 'GX', '再生', '事業拡大', '自社株', '新製品'],
  supplyDemand: ['自社株', 'ToSTNeT', '需給', '信用残', '株主還元', '分配資産', 'ETF', '増配'],
  revisions: ['上方修正', '増額', '予想', '業績修正', 'ガイダンス', '増配'],
  risks: ['停止', '減少', '減速', '下方修正', 'リコール', '懸念', '火災', '遅延', '減益', '中断']
};

app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

function dateTimeInTokyo(value) {
  if (!value) {
    return DateTime.now().setZone('Asia/Tokyo');
  }
  if (value instanceof DateTime) {
    return value.setZone('Asia/Tokyo');
  }
  return DateTime.fromISO(value, { zone: 'Asia/Tokyo' });
}

async function fetchStockFundamentals(code) {
  const url = `https://minkabu.jp/stock/${code}`;
  const { data } = await axios.get(url, { headers: { 'User-Agent': UA } });

  const industryMatch = data.match(/業種<\/span>\s*<a[^>]+>([^<]+)<\/a>/);
  const marketCapMatch = data.match(/>時価総額<\/th><td[^>]*>([0-9,]+)百万円/);
  const perMatch = data.match(/PER<[^>]+>[^<]*<\/span><\/th><td[^>]*>([0-9\.]*)倍/);
  const pbrMatch = data.match(/PBR<\/th><td[^>]*>([0-9\.]*)倍/);

  const marketCapHundredMillion = marketCapMatch ? parseInt(marketCapMatch[1].replace(/,/g, ''), 10) : null;
  const per = perMatch && perMatch[1] ? parseFloat(perMatch[1]) : null;
  const pbr = pbrMatch && pbrMatch[1] ? parseFloat(pbrMatch[1]) : null;

  let name = null;
  const ldJsonMatches = data.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  if (ldJsonMatches) {
    for (const scriptTag of ldJsonMatches) {
      try {
        const jsonText = scriptTag.replace(/<script type="application\/ld\+json">/, '').replace('</script>', '').trim();
        const payload = JSON.parse(jsonText);
        if (payload && payload.name && typeof payload.name === 'string') {
          name = payload.name.trim();
          break;
        }
      } catch (error) {
        // ignore parsing errors from unrelated script tags
      }
    }
  }

  return {
    name,
    industry: industryMatch ? industryMatch[1].trim() : '不明',
    marketCapHundredMillion,
    per,
    pbr,
    source: url
  };
}

async function fetchTradingStats(code) {
  const url = `https://stooq.com/q/d/l/?s=${code}.jp`;
  const { data } = await axios.get(url, { headers: { 'User-Agent': UA } });
  const rows = data
    .split('\n')
    .filter((line, index) => index > 0 && line)
    .map((line) => {
      const [date, open, high, low, close, volume] = line.split(',');
      return {
        date,
        close: parseFloat(close),
        volume: parseFloat(volume)
      };
    })
    .filter((item) => Number.isFinite(item.close) && Number.isFinite(item.volume));

  if (rows.length === 0) {
    return { avgTradingValueHundredMillion: null, closes: [], source: url };
  }

  const recent = rows.slice(-20);
  const tradingValues = recent.map((row) => row.close * row.volume);
  const avgTradingValueHundredMillion = tradingValues.reduce((sum, value) => sum + value, 0) / recent.length / 1e8;

  return {
    avgTradingValueHundredMillion,
    closes: rows.map((row) => row.close),
    source: url
  };
}

async function fetchKabutanNews(code) {
  const url = `https://kabutan.jp/stock/news?code=${code}`;
  const { data } = await axios.get(url, { headers: { 'User-Agent': UA } });
  const $ = cheerio.load(data);
  const news = [];

  $('table.s_news_list tr').each((_, row) => {
    const timeNode = $(row).find('td.news_time time');
    if (!timeNode.length) {
      return;
    }
    const iso = timeNode.attr('datetime');
    const date = iso ? DateTime.fromISO(iso, { zone: 'Asia/Tokyo' }) : null;
    const category = $(row).find('td div').text().trim();
    const anchor = $(row).find('a');
    const title = anchor.text().trim();
    const href = anchor.attr('href');
    if (!title || !href) {
      return;
    }
    const absoluteUrl = href.startsWith('http') ? href : `https://kabutan.jp${href}`;
    news.push({
      title,
      url,
      category,
      date,
      source: absoluteUrl
    });
  });

  return news;
}

function countMatches(newsItems, keywords) {
  if (!newsItems || newsItems.length === 0) {
    return 0;
  }
  const normalized = keywords.map((word) => word.toLowerCase());
  const hits = newsItems.filter((item) => {
    const text = `${item.title} ${item.category || ''}`.toLowerCase();
    return normalized.some((word) => text.includes(word));
  });
  return hits.length;
}

function evaluateCatalyst(newsItems) {
  const matches = countMatches(newsItems, keywordBuckets.catalyst);
  if (matches === 0) return 2.5;
  if (matches === 1) return 3.5;
  if (matches === 2) return 4.3;
  return 5;
}

function evaluateSupplyDemand(newsItems) {
  const matches = countMatches(newsItems, keywordBuckets.supplyDemand);
  if (matches === 0) return 2.5;
  if (matches === 1) return 3.5;
  if (matches === 2) return 4.2;
  return 4.8;
}

function evaluateRevisions(newsItems) {
  const matches = countMatches(newsItems, keywordBuckets.revisions);
  if (matches === 0) return 2.2;
  if (matches === 1) return 3.5;
  if (matches === 2) return 4.2;
  return 4.8;
}

function evaluateMomentum(closes) {
  if (!closes || closes.length < 5) {
    return 3;
  }
  const latest = closes[closes.length - 1];
  const slice = closes.slice(-10);
  const avg10 = slice.reduce((sum, value) => sum + value, 0) / slice.length;
  const pct = ((latest - avg10) / avg10) * 100;
  if (pct >= 5) return 5;
  if (pct >= 2) return 4;
  if (pct >= 0) return 3.2;
  if (pct >= -2) return 2.3;
  return 1.5;
}

function evaluateTechnical(closes) {
  if (!closes || closes.length < 30) {
    return 3;
  }
  const latest = closes[closes.length - 1];
  const ma20 = closes.slice(-20).reduce((sum, v) => sum + v, 0) / 20;
  const ma50 = closes.slice(-50).reduce((sum, v) => sum + v, 0) / Math.min(50, closes.length);
  let score = 2.5;
  if (latest > ma20) score += 1;
  if (ma20 > ma50) score += 1;
  if (latest > ma20 * 1.05) score += 0.3;
  if (score > 5) score = 5;
  return score;
}

function evaluateValuation(per, marketCapHundredMillion) {
  if (Number.isFinite(per)) {
    if (per <= 15) return 4.8;
    if (per <= 20) return 4.3;
    if (per <= 30) return 3.6;
    if (per <= 40) return 2.8;
    return 2.2;
  }
  if (Number.isFinite(marketCapHundredMillion)) {
    if (marketCapHundredMillion <= 5000) return 4.5;
    if (marketCapHundredMillion <= 10000) return 3.5;
    if (marketCapHundredMillion <= 20000) return 3;
    return 2.5;
  }
  return 3;
}

function computeScores(context) {
  const subscores = {
    Catalyst: evaluateCatalyst(context.newsRecent),
    Momentum: evaluateMomentum(context.closes),
    SupplyDemand: evaluateSupplyDemand(context.newsRecent),
    Revisions: evaluateRevisions(context.newsRecent),
    Technical: evaluateTechnical(context.closes),
    Valuation: evaluateValuation(context.per, context.marketCapHundredMillion)
  };

  const total = Object.entries(weights).reduce((sum, [key, weight]) => sum + weight * (subscores[key] / 5), 0);

  return { subscores, total: Number(total.toFixed(1)) };
}

function buildSummary(newsItems) {
  if (!newsItems || newsItems.length === 0) {
    return '直近14日以内の主要ニュースを取得できませんでした。';
  }
  const items = newsItems.slice(0, 3).map((item) => {
    const dateText = item.date ? item.date.toFormat('yyyy-LL-dd') : '日付不明';
    return `${dateText} ${item.title}`;
  });
  return items.join(' / ');
}

function buildRisk(newsItems) {
  if (!newsItems) {
    return '主要イベントの進捗に依存。追加情報を確認してください。';
  }
  const riskHits = newsItems.filter((item) => keywordBuckets.risks.some((word) => item.title.includes(word)));
  if (riskHits.length > 0) {
    return `${riskHits[0].title} など短期的な不確実性に注意[${riskHits[0].source}]`;
  }
  return '大型案件の進捗や為替・政策動向による変動リスクに留意。';
}

function uniqueSources(...sourceGroups) {
  const set = new Set();
  sourceGroups.forEach((group) => {
    if (Array.isArray(group)) {
      group.forEach((entry) => {
        if (entry) set.add(entry);
      });
    } else if (group) {
      set.add(group);
    }
  });
  return Array.from(set);
}

async function buildStockInsight(candidate, options = {}) {
  const fundamentals = await fetchStockFundamentals(candidate.code);
  const trading = await fetchTradingStats(candidate.code);
  const news = await fetchKabutanNews(candidate.code);

  const recentNews = news.filter((item) => item.date && dateTimeInTokyo(item.date).diffNow('days').days >= -14);
  const scoringContext = {
    newsRecent: recentNews.length > 0 ? recentNews : news.slice(0, 3),
    closes: trading.closes,
    per: fundamentals.per,
    marketCapHundredMillion: fundamentals.marketCapHundredMillion
  };

  const { subscores, total } = computeScores(scoringContext);
  const sortedNews = scoringContext.newsRecent.sort((a, b) => {
    const da = a.date ? a.date.valueOf() : 0;
    const db = b.date ? b.date.valueOf() : 0;
    return db - da;
  });
  const trigger = sortedNews.length > 0 && sortedNews[0].date ? sortedNews[0].date.toFormat('yyyy-LL-dd') : 'N/A';

  return {
    ticker: candidate.code,
    name: fundamentals.name || candidate.name,
    industry: fundamentals.industry,
    marketCapHundredMillion: fundamentals.marketCapHundredMillion,
    avgTradingValueHundredMillion: trading.avgTradingValueHundredMillion ? Number(trading.avgTradingValueHundredMillion.toFixed(2)) : null,
    newsSummary: buildSummary(sortedNews),
    scoreTotal: total,
    subscores,
    triggerDate: trigger,
    keyRisks: buildRisk(sortedNews),
    sources: uniqueSources(fundamentals.source, trading.source, sortedNews.map((item) => item.source))
  };
}

app.post('/api/generate', async (req, res) => {
  const { candidates, limit } = req.body || {};
  const selected = Array.isArray(candidates) && candidates.length > 0
    ? defaultCandidates.filter((item) => candidates.includes(item.code))
    : defaultCandidates;
  const finalLimit = Number.isFinite(limit) ? limit : DEFAULT_LIMIT;

  try {
    const insights = [];
    for (const candidate of selected) {
      try {
        const insight = await buildStockInsight(candidate);
        insights.push(insight);
      } catch (error) {
        insights.push({
          ticker: candidate.code,
          name: candidate.name,
          industry: '取得失敗',
          error: `データ取得に失敗しました: ${error.message}`
        });
      }
    }

    const validInsights = insights
      .filter((item) => item.scoreTotal)
      .sort((a, b) => b.scoreTotal - a.scoreTotal)
      .slice(0, finalLimit);

    const generatedAt = DateTime.now().setZone('Asia/Tokyo').toISO();

    res.json({
      generatedAt,
      timezone: 'Asia/Tokyo',
      results: validInsights,
      fallback: insights.filter((item) => !item.scoreTotal)
    });
  } catch (error) {
    res.status(500).json({ message: 'スコアリング処理でエラーが発生しました。', detail: error.message });
  }
});

app.use(express.static(FRONTEND_DIR));

app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Japanese stock idea server listening on http://localhost:${PORT}`);
});
