// BrewLine 公開溯源頁（S2c，ADR-031 D2）。QR 網址是 trace.<網域>/#<token>：
// token 在 fragment，瀏覽器不會送到伺服器，也不會出現在 Referer。
// 所有資料都用 textContent 輸出（不解析 HTML），召回文字即使含標記也只會顯示成文字。
// Public trace page. The token lives in the URL fragment (never sent to the server or in the Referer);
// every value is written with textContent; nothing is parsed as HTML.
'use strict';
(function () {
  var TOKEN = /^[A-Za-z0-9_-]{22}$/;
  var T = {
    'zh-Hant': {
      loading: '載入中…', notFound: '找不到這個溯源碼。請確認包裝上的 QR Code。', error: '暫時無法載入，請稍後再試。',
      demo: '這是作品集的示範資料，不是真實商品。', recallTitle: '召回通知', origin: '產地', roast: '烘焙',
      footer: 'BrewLine 是 AWS 架構作品集，不是商業網站。生產者名稱為虛構。', other: 'English',
      producer: '生產者', country: '國家', region: '產區', altitude: '海拔', variety: '品種', process: '處理法',
      cup: '杯測分數', harvest: '採收季', roastDate: '烘焙日期', roastLevel: '烘焙度', recalledAt: '公告時間',
      process_washed: '水洗', process_natural: '日曬', process_honey: '蜜處理', process_anaerobic: '厭氧', 'process_wet-hulled': '濕剝',
      level_light: '淺焙', 'level_medium-light': '中淺焙', level_medium: '中焙', 'level_medium-dark': '中深焙', level_dark: '深焙',
      CO: '哥倫比亞', ET: '衣索比亞', GT: '瓜地馬拉', ID: '印尼', KE: '肯亞', PA: '巴拿馬', TW: '台灣',
    },
    en: {
      loading: 'Loading…', notFound: 'This trace code was not found. Please check the QR code on the bag.', error: 'Could not load right now. Please try again later.',
      demo: 'Portfolio demo data, not a real product.', recallTitle: 'Recall notice', origin: 'Origin', roast: 'Roast',
      footer: 'BrewLine is an AWS architecture portfolio, not a commercial site. Producer names are fictional.', other: '中文',
      producer: 'Producer', country: 'Country', region: 'Region', altitude: 'Altitude', variety: 'Variety', process: 'Process',
      cup: 'Cup score', harvest: 'Harvest', roastDate: 'Roast date', roastLevel: 'Roast level', recalledAt: 'Issued',
      process_washed: 'Washed', process_natural: 'Natural', process_honey: 'Honey', process_anaerobic: 'Anaerobic', 'process_wet-hulled': 'Wet-hulled',
      level_light: 'Light', 'level_medium-light': 'Medium-light', level_medium: 'Medium', 'level_medium-dark': 'Medium-dark', level_dark: 'Dark',
      CO: 'Colombia', ET: 'Ethiopia', GT: 'Guatemala', ID: 'Indonesia', KE: 'Kenya', PA: 'Panama', TW: 'Taiwan',
    },
  };
  var lang = /^zh/i.test(navigator.language || '') ? 'zh-Hant' : 'en';
  var data = null;
  var state = 'loading';

  function t(k) { var v = T[lang][k]; return v === undefined ? k : v; }
  function el(id) { return document.getElementById(id); }
  function row(dl, label, value) {
    if (value === undefined || value === null || value === '') return;
    var dt = document.createElement('dt'); dt.textContent = label;
    var dd = document.createElement('dd'); dd.textContent = String(value);
    dl.appendChild(dt); dl.appendChild(dd);
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function render() {
    document.documentElement.lang = lang;
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    el('lang').textContent = t('other');
    var status = el('status');
    if (state !== 'ok') { status.hidden = false; status.textContent = t(state); el('trace').hidden = true; return; }
    status.hidden = true;
    el('trace').hidden = false;
    el('demo').hidden = !data.demo;
    el('product').textContent = lang === 'zh-Hant' && data.product.name_zh ? data.product.name_zh : data.product.name;
    var lot = el('lot'); clear(lot);
    row(lot, t('producer'), data.lot.producer_display_name);
    row(lot, t('country'), t(data.lot.origin_country));
    row(lot, t('region'), data.lot.region);
    row(lot, t('altitude'), data.lot.altitude_m + ' m');
    row(lot, t('variety'), data.lot.variety);
    row(lot, t('process'), t('process_' + data.lot.process));
    row(lot, t('cup'), data.lot.cup_score);
    row(lot, t('harvest'), data.lot.harvest);
    var roast = el('roast'); clear(roast);
    row(roast, t('roastDate'), data.roast.roast_date);
    row(roast, t('roastLevel'), t('level_' + data.roast.roast_level));
    var recall = el('recall');
    recall.hidden = !data.recall;
    if (data.recall) {
      el('recall-notice').textContent = data.recall.notice;
      el('recall-at').textContent = t('recalledAt') + ': ' + data.recall.at.slice(0, 10);
    }
  }

  function load() {
    var token = (location.hash || '').slice(1);
    if (!TOKEN.test(token)) { state = 'notFound'; render(); return; }
    fetch('/v1/' + token + '.json', { credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (r) {
        if (r.status === 404 || r.status === 403) { state = 'notFound'; return null; }
        if (!r.ok) { state = 'error'; return null; }
        return r.json();
      })
      .then(function (json) {
        if (json && json.schema === 1 && json.product && json.lot && json.roast) { data = json; state = 'ok'; }
        else if (state === 'loading') state = 'error';
        render();
      })
      .catch(function () { state = 'error'; render(); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    el('lang').addEventListener('click', function () { lang = lang === 'en' ? 'zh-Hant' : 'en'; render(); });
    window.addEventListener('hashchange', function () { state = 'loading'; data = null; render(); load(); });
    render();
    load();
  });
})();
