(function () {
  const { useState, useMemo } = React;

  const ScoreTile = ({ label, value }) => {
    const percentage = Math.max(0, Math.min(100, (value / 5) * 100));
    return React.createElement(
      'div',
      { className: 'score-tile' },
      React.createElement('strong', null, `${label} (${value.toFixed(1)})`),
      React.createElement(
        'div',
        { className: 'score-bar-wrapper' },
        React.createElement('div', { className: 'score-bar', style: { width: `${percentage}%` } })
      )
    );
  };

  const MetaItem = ({ label, value }) =>
    React.createElement(
      'div',
      { className: 'meta-item' },
      React.createElement('span', { className: 'meta-label' }, label),
      React.createElement('span', { className: 'meta-value' }, value)
    );

  function formatHundredMillion(num) {
    if (num == null || Number.isNaN(num)) return 'N/A';
    const formatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
    if (Math.abs(num) >= 10000) {
      return `${formatter.format(num / 10000)} 兆円`;
    }
    return `${formatter.format(num)} 億円`;
  }

  const ResultCard = ({ result }) => {
    const { subscores } = result;
    const sourceLinks = (result.sources || []).map((url) =>
      React.createElement(
        'a',
        { key: url, href: url, target: '_blank', rel: 'noreferrer noopener' },
        url
      )
    );

    return React.createElement(
      'article',
      { className: 'card' },
      React.createElement(
        'div',
        { className: 'card-header' },
        React.createElement('div', null, React.createElement('span', { className: 'ticker' }, result.ticker)),
        React.createElement('div', null, React.createElement('strong', null, `${result.scoreTotal}`))
      ),
      React.createElement('h2', null, result.name || result.ticker),
      React.createElement('p', { className: 'summary' }, result.newsSummary || '最新ニュースの要約がありません。'),
      React.createElement(
        'div',
        { className: 'meta-grid' },
        React.createElement(MetaItem, { label: '業種', value: result.industry || 'N/A' }),
        React.createElement(MetaItem, { label: '時価総額', value: formatHundredMillion(result.marketCapHundredMillion) }),
        React.createElement(MetaItem, { label: '平均売買代金(20日)', value: formatHundredMillion(result.avgTradingValueHundredMillion) }),
        React.createElement(MetaItem, { label: '想定トリガー日', value: result.triggerDate || 'N/A' })
      ),
      React.createElement(
        'div',
        { className: 'score-grid' },
        Object.entries(subscores || {}).map(([key, value]) =>
          React.createElement(ScoreTile, { key: key, label: key, value })
        )
      ),
      React.createElement('div', null, React.createElement('strong', null, '主要リスク'), React.createElement('p', { className: 'summary' }, result.keyRisks || '情報不足。')),
      sourceLinks.length
        ? React.createElement('div', { className: 'link-list' }, sourceLinks)
        : null
    );
  };

  const App = () => {
    const [results, setResults] = useState([]);
    const [fallback, setFallback] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [generatedAt, setGeneratedAt] = useState(null);

    const apiBase = window.API_BASE_URL || '';

    const handleGenerate = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${apiBase}/api/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ limit: 5 })
        });
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }
        const payload = await response.json();
        setResults(payload.results || []);
        setFallback(payload.fallback || []);
        setGeneratedAt(payload.generatedAt || null);
      } catch (err) {
        setError(err.message || '不明なエラーです');
      } finally {
        setLoading(false);
      }
    };

    const timestampLabel = useMemo(() => {
      if (!generatedAt) return null;
      try {
        const date = new Date(generatedAt);
        return new Intl.DateTimeFormat('ja-JP', {
          dateStyle: 'medium',
          timeStyle: 'short'
        }).format(date);
      } catch (err) {
        return generatedAt;
      }
    }, [generatedAt]);

    return React.createElement(
      'div',
      { className: 'app-shell' },
      React.createElement(
        'header',
        { className: 'app-header' },
        React.createElement('h1', null, '日本株アイデア自動選定エージェント'),
        React.createElement('p', null, '最新ニュース・開示情報・需給を組み合わせて上昇ポテンシャルの高い銘柄をスコアリングします。'),
        React.createElement(
          'div',
          { className: 'controls' },
          React.createElement(
            'button',
            { className: 'primary-button', onClick: handleGenerate, disabled: loading },
            loading ? '分析中…' : 'ワンクリックで生成'
          ),
          timestampLabel
            ? React.createElement(
                'div',
                { className: 'status-pill' },
                React.createElement('span', null, '最終更新:'),
                React.createElement('strong', null, timestampLabel)
              )
            : null
        )
      ),
      error ? React.createElement('div', { className: 'alert' }, `エラー: ${error}`) : null,
      results.length
        ? React.createElement(
            'section',
            { className: 'grid' },
            results.map((item) => React.createElement(ResultCard, { key: item.ticker, result: item }))
          )
        : !loading &&
          React.createElement('p', { className: 'summary' }, '「ワンクリックで生成」を押してスコアリングを開始します。'),
      fallback.length
        ? React.createElement(
            'section',
            { className: 'fallback' },
            React.createElement('h3', null, '取得に失敗した銘柄'),
            fallback.map((item) =>
              React.createElement(
                'div',
                { className: 'fallback-item', key: item.ticker },
                `${item.ticker}: ${item.error || 'データなし'}`
              )
            )
          )
        : null
    );
  };

  const rootElement = document.getElementById('root');
  ReactDOM.createRoot(rootElement).render(React.createElement(App));
})();
