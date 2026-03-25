// ==UserScript==
// @name         MultiSoup Geospace 住所検索バー（試作）
// @namespace    https://multisoup.co.jp/
// @version      0.1.0
// @description  geospace.php に住所検索UIを後付けし、取得した座標へ地図中心を移動する試作スクリプト
// @match        https://multisoup.co.jp/map/geospace.php*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      msearch.gsi.go.jp
// @connect      geocode.csis.u-tokyo.ac.jp
// @connect      www.geocoding.jp
// ==/UserScript==

(function () {
  'use strict';

  /**
   * ----------------------------
   * 設定値（必要に応じて調整）
   * ----------------------------
   */
  const DEFAULT_ZOOM = 18;
  const MAP_WAIT_TIMEOUT_MS = 15000;
  const PANEL_Z_INDEX = 99999;

  /**
   * ステータス表示を更新するヘルパー
   * @param {HTMLElement} el
   * @param {string} msg
   * @param {'info'|'ok'|'warn'|'error'} level
   */
  function setStatus(el, msg, level = 'info') {
    const colorMap = {
      info: '#333',
      ok: '#0b7a0b',
      warn: '#8a6d00',
      error: '#b00020'
    };
    el.style.color = colorMap[level] || colorMap.info;
    el.textContent = msg;
  }

  /**
   * ページ側の omapControl を待機して取得する。
   * geospace.php では global 変数として `var omapControl = OMapControl();` が定義されるため、
   * Tampermonkey 側から unsafeWindow 経由で参照する。
   */
  function waitForOmapControl(timeoutMs = MAP_WAIT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const page = unsafeWindow;
        const oc = page && page.omapControl;
        const isReady = oc && typeof oc.setCenter === 'function' && typeof oc.layout === 'function';

        if (isReady) {
          clearInterval(timer);
          resolve(oc);
          return;
        }

        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error('omapControl が見つからないか、初期化が完了していません。'));
        }
      }, 200);
    });
  }

  /**
   * 緯度経度文字列をパースする。
   * 例:
   * - "35.6586,139.7454"
   * - "139.7454 35.6586"（lon lat）
   * 先頭が緯度か経度かを値域で判定する。
   */
  function parseLatLonText(text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) return null;

    const parts = cleaned.split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 2) return null;

    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

    // 値域判定: 緯度 [-90,90], 経度 [-180,180]
    const aIsLat = a >= -90 && a <= 90;
    const aIsLon = a >= -180 && a <= 180;
    const bIsLat = b >= -90 && b <= 90;
    const bIsLon = b >= -180 && b <= 180;

    if (aIsLat && bIsLon) return { lat: a, lon: b };
    if (aIsLon && bIsLat) return { lat: b, lon: a };

    return null;
  }

  /**
   * TampermonkeyのクロスオリジンGET。
   * fetch + CORS 制約を避けるため GM_xmlhttpRequest を使用する。
   */
  function httpGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText);
          } else {
            reject(new Error(`HTTP ${res.status}: ${url}`));
          }
        },
        ontimeout: () => reject(new Error(`Timeout: ${url}`)),
        onerror: () => reject(new Error(`Request failed: ${url}`))
      });
    });
  }

  function toHalfWidthDigits(text) {
    return String(text || '').replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248));
  }

  function normalizeAddressText(text) {
    return toHalfWidthDigits(String(text || ''))
      .toLowerCase()
      .replace(/[\s\u3000]/g, '')
      .replace(/[丁目番地号\-－ー‐−.,、。]/g, '');
  }

  /**
   * geocoding.jp (無料・キー不要) を使った住所検索。
   * XMLで返るため DOMParser で解析する。
   */
  async function geocodeByGeocodingJp(address) {
    const url = `https://www.geocoding.jp/api/?q=${encodeURIComponent(address)}`;
    const xmlText = await httpGet(url);
    const xml = new DOMParser().parseFromString(xmlText, 'text/xml');

    const latText = xml.querySelector('coordinate > lat')?.textContent;
    const lonText = xml.querySelector('coordinate > lng')?.textContent;
    const label = xml.querySelector('address')?.textContent || address;
    const needsToVerify = (xml.querySelector('needs_to_verify')?.textContent || '').toLowerCase() === 'yes';

    const lat = Number(latText);
    const lon = Number(lonText);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }

    return {
      source: 'geocoding.jp',
      lat,
      lon,
      label,
      coarse: needsToVerify
    };
  }

  /**
   * 国土地理院 AddressSearch API
   */
  async function geocodeByGsi(address) {
    const endpoint = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(address)}`;
    const text = await httpGet(endpoint);
    const data = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const first = data[0];
    const coords = first && first.geometry && first.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      return null;
    }

    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }

    return {
      source: 'gsi',
      lat,
      lon,
      label: first.properties && first.properties.title ? first.properties.title : address,
      coarse: true
    };
  }

  /**
   * CSIS簡易ジオコーディング
   */
  async function geocodeByCsis(address) {
    const endpoint = `https://geocode.csis.u-tokyo.ac.jp/cgi-bin/simple_geocode.cgi?addr=${encodeURIComponent(address)}&charset=UTF8`;
    const xmlText = await httpGet(endpoint);
    const xml = new DOMParser().parseFromString(xmlText, 'text/xml');

    const latText = xml.querySelector('candidate > latitude')?.textContent;
    const lonText = xml.querySelector('candidate > longitude')?.textContent;
    const label = xml.querySelector('converted')?.textContent || address;
    const levelText = xml.querySelector('candidate > iLvl')?.textContent || '0';

    const lat = Number(latText);
    const lon = Number(lonText);
    const level = Number(levelText);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }

    return {
      source: 'csis',
      lat,
      lon,
      label,
      coarse: level <= 5
    };
  }

  function scoreGeocodeResult(query, candidate) {
    if (!candidate) return -9999;

    const q = normalizeAddressText(query);
    const l = normalizeAddressText(candidate.label || '');
    const queryHasDigit = /\d/.test(toHalfWidthDigits(query));
    const labelHasDigit = /\d/.test(toHalfWidthDigits(candidate.label || ''));

    let score = 0;

    if (candidate.source === 'geocoding.jp') score += 40;
    if (candidate.source === 'gsi') score += 15;
    if (candidate.source === 'csis') score += 10;

    if (l && q && l.includes(q)) score += 50;
    else if (l && q && q.includes(l)) score += 15;

    if (queryHasDigit && labelHasDigit) score += 20;
    if (queryHasDigit && !labelHasDigit) score -= 25;

    if (candidate.coarse) score -= 10;

    return score;
  }

  /**
   * 複数の無料ジオコーダーを順に実行し、最も一致度が高い候補を採用する。
   */
  async function geocodeAddressMulti(address) {
    const candidates = [];
    const errors = [];

    const providers = [
      { name: 'geocoding.jp', fn: geocodeByGeocodingJp },
      { name: 'gsi', fn: geocodeByGsi },
      { name: 'csis', fn: geocodeByCsis }
    ];

    for (const p of providers) {
      try {
        const r = await p.fn(address);
        if (r) {
          candidates.push(r);

          // かなり一致が高い場合は早期採用
          if (scoreGeocodeResult(address, r) >= 95) {
            return { best: r, candidates, errors };
          }
        }
      } catch (e) {
        errors.push(`${p.name}: ${e && e.message ? e.message : String(e)}`);
      }
    }

    if (candidates.length === 0) {
      return { best: null, candidates, errors };
    }

    candidates.sort((a, b) => scoreGeocodeResult(address, b) - scoreGeocodeResult(address, a));
    return { best: candidates[0], candidates, errors };
  }

  /**
   * 実際に地図中心を移動する。
   * 根拠: ページ実装の OMapControl#setCenter(lon, lat, zoom) が OpenLayers.Map#setCenter を呼んでいる。
   */
  async function moveMapCenter(lat, lon, zoom = DEFAULT_ZOOM) {
    const oc = await waitForOmapControl();

    // 念のためレイアウト反映と可視化を実行（ページ側にも show/layout は存在）
    try {
      oc.layout();
      if (typeof oc.show === 'function') {
        oc.show();
      }
    } catch (e) {
      // 補助呼び出しなので失敗しても setCenter は継続
    }

    const map = typeof oc.getMap === 'function' ? oc.getMap() : null;

    // OpenLayers はサイズ計算タイミングで見かけ上の中心がずれる場合があるため、
    // updateSize と再センタリングを行って安定化する。
    if (map && typeof map.updateSize === 'function') {
      map.updateSize();
    }

    oc.setCenter(lon, lat, zoom);

    // レイアウト確定後にもう一度 center を適用（視覚的なズレ対策）
    setTimeout(() => {
      try {
        if (map && typeof map.updateSize === 'function') {
          map.updateSize();
        }
        oc.setCenter(lon, lat, zoom);
      } catch (e) {
        // 補助処理のため握りつぶす
      }
    }, 120);
  }

  /**
   * UIを後付けで描画
   */
  function buildUi() {
    const panel = document.createElement('div');
    panel.id = 'tm-address-search-panel';
    panel.style.position = 'fixed';
    panel.style.top = '10px';
    panel.style.left = '10px';
    panel.style.zIndex = String(PANEL_Z_INDEX);
    panel.style.background = 'rgba(255,255,255,0.95)';
    panel.style.border = '1px solid #999';
    panel.style.padding = '8px';
    panel.style.width = '320px';
    panel.style.fontSize = '12px';
    panel.style.fontFamily = 'sans-serif';
    panel.style.boxShadow = '0 1px 4px rgba(0,0,0,0.2)';

    const title = document.createElement('div');
    title.textContent = '住所検索（試作）';
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '6px';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '住所 または 緯度経度（35.68,139.76）';
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.marginBottom = '6px';

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '6px';

    const searchBtn = document.createElement('button');
    searchBtn.textContent = '検索';
    searchBtn.style.cursor = 'pointer';

    const zoomInput = document.createElement('input');
    zoomInput.type = 'number';
    zoomInput.min = '1';
    zoomInput.max = '19';
    zoomInput.value = String(DEFAULT_ZOOM);
    zoomInput.title = 'ズーム';
    zoomInput.style.width = '70px';

    row.appendChild(searchBtn);
    row.appendChild(zoomInput);

    const result = document.createElement('div');
    result.style.marginTop = '6px';
    result.style.whiteSpace = 'pre-wrap';
    result.textContent = '待機中...';

    const note = document.createElement('div');
    note.style.marginTop = '6px';
    note.style.fontSize = '11px';
    note.style.color = '#666';
    note.textContent = '※住所検索時は外部API（geocoding.jp / 国土地理院 / CSIS）へ入力文字列を送信します';

    panel.appendChild(title);
    panel.appendChild(input);
    panel.appendChild(row);
    panel.appendChild(result);
    panel.appendChild(note);
    document.body.appendChild(panel);

    // Enterキーで検索
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        searchBtn.click();
      }
    });

    // 検索処理
    searchBtn.addEventListener('click', async () => {
      const raw = input.value.trim();
      const zoom = Number(zoomInput.value) || DEFAULT_ZOOM;

      if (!raw) {
        setStatus(result, '住所または座標を入力してください。', 'warn');
        return;
      }

      searchBtn.disabled = true;
      setStatus(result, '検索中...', 'info');

      try {
        // 1) まず緯度経度直入力として解釈（外部送信なし）
        const parsed = parseLatLonText(raw);
        if (parsed) {
          await moveMapCenter(parsed.lat, parsed.lon, zoom);
          setStatus(
            result,
            `座標移動しました\nlat: ${parsed.lat.toFixed(6)}\nlon: ${parsed.lon.toFixed(6)}\nzoom: ${zoom}`,
            'ok'
          );
          return;
        }

        // 2) 住所としてジオコーディング
        const geoResult = await geocodeAddressMulti(raw);
        const geo = geoResult.best;
        if (!geo) {
          const detail = geoResult.errors.length ? `\n詳細: ${geoResult.errors.join(' | ')}` : '';
          setStatus(result, `候補が見つかりませんでした。住所を具体化してください。${detail}`, 'warn');
          return;
        }

        // 住所文字列と候補の一致度から「丸め」を判定
        const rawNorm = normalizeAddressText(raw);
        const labelNorm = normalizeAddressText(geo.label || '');
        const queryHasDigit = /\d/.test(toHalfWidthDigits(raw));
        const labelHasDigit = /\d/.test(toHalfWidthDigits(geo.label || ''));
        const mayBeCoarse =
          geo.coarse ||
          (queryHasDigit && !labelHasDigit) ||
          !(labelNorm.includes(rawNorm) || rawNorm.includes(labelNorm));

        await moveMapCenter(geo.lat, geo.lon, zoom);

        const coarseNote = mayBeCoarse
          ? '\n※注意: 結果が広域（町丁目レベル等）に丸められている可能性があります'
          : '';
        const tried = geoResult.candidates.map((c) => c.source).join(', ');
        const errInfo = geoResult.errors.length ? `\n補足: ${geoResult.errors.join(' | ')}` : '';

        setStatus(
          result,
          `移動しました\n候補: ${geo.label}\nsource: ${geo.source}\nlat: ${geo.lat.toFixed(6)}\nlon: ${geo.lon.toFixed(6)}\nzoom: ${zoom}\n候補取得: ${tried}${coarseNote}${errInfo}`,
          'ok'
        );
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        setStatus(result, `失敗: ${msg}`, 'error');
      } finally {
        searchBtn.disabled = false;
      }
    });

    // map初期化状態を表示
    waitForOmapControl(3000)
      .then(() => setStatus(result, '準備完了。住所または座標を入力してください。', 'ok'))
      .catch(() => setStatus(result, '地図初期化待ち。しばらくして再試行してください。', 'warn'));
  }

  // 実行
  buildUi();
})();
