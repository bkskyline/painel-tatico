const { useState, useEffect, useCallback, useMemo } = React;

// ---------- Design tokens ----------
const C = {
  bg: "#15140f", bgPanel: "#1d1c15", bgPanel2: "#242219", line: "#33301f",
  ink: "#ece6d6", inkDim: "#a39c85", inkFaint: "#726b56",
  brass: "#c9a24b", brassDim: "#8a713a", felt: "#4f7a5c", feltBright: "#6fae7f",
  rust: "#b5533c", rustBright: "#d97052", sky: "#5a8fae",
};

// ---------- PGN parsing ----------
function parsePGN(pgn) {
  const tagMatches = [...pgn.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)];
  const tags = {};
  tagMatches.forEach((m) => (tags[m[1]] = m[2]));
  let body = pgn.replace(/\[(\w+)\s+"([^"]*)"\]/g, "").trim();
  body = body.replace(/\{[^}]*\}/g, "");
  body = body.replace(/\$\d+/g, "");
  body = body.replace(/\([^()]*\)/g, "");
  body = body.replace(/(1-0|0-1|1\/2-1\/2|\*)\s*$/, "").trim();
  const moveTokens = body.split(/\s+/).filter((t) => t && !/^\d+\.(\.\.)?$/.test(t) && !/^\d+\.$/.test(t));
  return { tags, moves: moveTokens, raw: pgn };
}

function classifyMoves(moves) {
  const counts = { genius: 0, best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  moves.forEach((mv) => {
    if (/!!$/.test(mv)) counts.genius++;
    else if (/\?\?$/.test(mv)) counts.blunder++;
    else if (/\?!$/.test(mv)) counts.inaccuracy++;
    else if (/\?$/.test(mv)) counts.mistake++;
    else if (/!$/.test(mv)) counts.best++;
    else counts.good++;
  });
  return counts;
}

// Determines which side (white/black/unknown) the user played, given saved usernames.
// Returns "unknown" when neither White nor Black tag matches "Você" or a known username —
// in that case the caller should prompt the person to pick a side manually.
function detectUserSide(tags, knownUsernames = []) {
  const white = (tags.White || "").trim().toLowerCase();
  const black = (tags.Black || "").trim().toLowerCase();
  const isVoce = (s) => /voc[eê]/i.test(s);
  const normalizedKnown = knownUsernames.map((u) => u.trim().toLowerCase()).filter(Boolean);

  if (isVoce(white) && !isVoce(black)) return "white";
  if (isVoce(black) && !isVoce(white)) return "black";
  if (normalizedKnown.includes(white) && !normalizedKnown.includes(black)) return "white";
  if (normalizedKnown.includes(black) && !normalizedKnown.includes(white)) return "black";
  return "unknown";
}

// Splits the flat move list (White, Black, White, Black, ...) into each side's moves.
function splitMovesBySide(moves) {
  const white = [];
  const black = [];
  moves.forEach((mv, i) => {
    if (i % 2 === 0) white.push(mv);
    else black.push(mv);
  });
  return { white, black };
}

// Returns only the moves belonging to the user, given an explicit resolved side
// ("white" | "black"). Falls back to all moves if side is "unknown" — callers should
// avoid that case by resolving the side (auto-detect or manual pick) before calling.
function userMoves(moves, side) {
  const { white, black } = splitMovesBySide(moves);
  if (side === "white") return white;
  if (side === "black") return black;
  return moves;
}

function detectResult(tags, resolvedSide) {
  const r = tags.Result || "*";
  const side = resolvedSide || detectUserSide(tags);
  let outcome = "desconhecido";
  if (r === "1-0") outcome = side === "white" ? "vitória" : side === "black" ? "derrota" : "brancas venceram";
  else if (r === "0-1") outcome = side === "black" ? "vitória" : side === "white" ? "derrota" : "pretas venceram";
  else if (r === "1/2-1/2") outcome = "empate";
  return { outcome, userColor: side };
}

function openingFamily(ecoOrName) {
  if (!ecoOrName) return "Desconhecida";
  const s = ecoOrName.split(":")[0].trim();
  return s || ecoOrName;
}

// ---------- Storage (localStorage-backed) ----------
const GAMES_KEY = "chesskpi:games";
const SETTINGS_KEY = "chesskpi:settings";

function loadGames() {
  try {
    const raw = localStorage.getItem(GAMES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveGames(games) {
  try { localStorage.setItem(GAMES_KEY, JSON.stringify(games)); }
  catch (e) { console.error("localStorage set failed", e); }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : { usernames: [] };
  } catch { return { usernames: [] }; }
}
function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch (e) { console.error("localStorage set failed", e); }
}

// ---------- Engine adapters ----------
// Dedicated proxy: a Cloudflare Worker deployed by the user specifically to relay
// Lichess API calls with proper CORS headers. Replaces the public third-party proxy
// (corsproxy.io), which repeatedly failed under load by returning HTML error pages
// instead of the real response. This Worker only talks to lichess.org, so it's not
// subject to the rate-limiting/instability of a shared public proxy.
const LICHESS_WORKER_BASE = "https://painel-tatico-lichess-proxy.br-bkskyline.workers.dev";

async function lichessFetch(lichessUrl, options) {
  // lichessUrl looks like "https://lichess.org/api/import" — the worker expects the
  // same path under /lichess/, e.g. "https://<worker>/lichess/api/import".
  const path = lichessUrl.replace("https://lichess.org", "");
  const proxiedUrl = LICHESS_WORKER_BASE + "/lichess" + path;
  return fetch(proxiedUrl, options);
}

// Guards against proxies that fail "successfully" — returning HTTP 200 with an HTML error
// page instead of the real JSON/PGN payload. Throws a clear error instead of letting
// JSON.parse() fail later with a confusing "Unexpected token '<'" message.
async function assertJsonResponse(res) {
  const text = await res.text();
  const trimmed = text.trim();
  console.log("Lichess: raw response body (first 500 chars):", trimmed.slice(0, 500));
  if (trimmed.startsWith("<")) {
    throw new Error("Proxy returned an HTML page instead of JSON — the CORS proxy is likely down or rate-limiting.");
  }
  return JSON.parse(trimmed);
}

// Extracts [%eval ...] annotations from a Lichess-analysed PGN's movetext and returns them
// as a flat array of centipawn scores (from White's perspective), one per ply, in game order.
// Mate scores are converted to a large finite number preserving sign.
function extractLichessEvals(pgnWithEvals) {
  const evalRegex = /\[%eval\s+(#?-?\d+(?:\.\d+)?)\]/g;
  const evals = [];
  let m;
  while ((m = evalRegex.exec(pgnWithEvals)) !== null) {
    const raw = m[1];
    if (raw.startsWith("#")) {
      const mateIn = parseInt(raw.slice(1), 10);
      evals.push(mateIn > 0 ? 10000 : -10000);
    } else {
      evals.push(Math.round(parseFloat(raw) * 100)); // pawns -> centipawns
    }
  }
  return evals;
}

// Imports a PGN to Lichess (via CORS proxy), polls its export endpoint until the analysis
// (%eval comments) is present or a timeout is hit, then classifies the user's own moves
// by centipawn loss — same bucket vocabulary as the local Stockfish path.
// Step 1 of the semi-manual Lichess flow: import the PGN and return its Lichess URL.
// The Lichess API has no endpoint to trigger the "Request a computer analysis" action
// programmatically — that's a website-only action (confirmed: no such route exists in
// the public API docs). So after this import, the person needs to open the returned URL,
// click "Request a computer analysis" themselves, wait for it to finish, then come back
// and use fetchLichessAnalysis() to pull the now-ready evals.
async function importToLichess(pgn) {
  try {
    console.log("Lichess: importing PGN via proxy...");
    const importRes = await lichessFetch("https://lichess.org/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "pgn=" + encodeURIComponent(pgn),
    });
    if (!importRes.ok) {
      console.error("Lichess: import request failed, status", importRes.status);
      return { ok: false, reason: "import_failed" };
    }
    let data;
    try {
      data = await assertJsonResponse(importRes);
    } catch (parseErr) {
      console.error("Lichess: import response was not valid JSON.", parseErr.message);
      return { ok: false, reason: "proxy_html_response" };
    }
    console.log("Lichess: import response", data);
    if (!data.id) {
      console.error("Lichess: import response had no game id", data);
      return { ok: false, reason: "no_id" };
    }
    return { ok: true, id: data.id, url: data.url };
  } catch (e) {
    console.error("Lichess: uncaught error during import:", e);
    return { ok: false, reason: "network" };
  }
}

// Step 2 of the semi-manual Lichess flow: fetch the analysed PGN for a game that has
// (hopefully) already been analysed by the person clicking "Request a computer analysis"
// on lichess.org. Single attempt, no polling loop — if it's not ready yet, the person
// just waits a bit longer and tries this step again.
async function fetchLichessAnalysis(gameId, pgn, side) {
  try {
    console.log("Lichess: fetching analysed PGN for", gameId);
    const exportRes = await lichessFetch(`https://lichess.org/game/export/${gameId}?evals=1&clocks=0`, {
      headers: { Accept: "application/x-chess-pgn" },
    });
    if (!exportRes.ok) {
      console.error("Lichess: export request failed, status", exportRes.status);
      return { ok: false, reason: "export_failed" };
    }
    const text = await exportRes.text();
    const hasEval = text.includes("%eval");
    console.log(`Lichess: export — has %eval: ${hasEval}, length: ${text.length}`);
    if (!hasEval) {
      return { ok: false, reason: "analysis_not_ready" };
    }

    const evals = extractLichessEvals(text);
    const plies = buildPlyList(pgn);
    console.log(`Lichess: extracted ${evals.length} evals, ${plies ? plies.length : 0} plies`);
    if (!plies || evals.length === 0) {
      console.error("Lichess: failed to build ply list or extract evals from analysed PGN.");
      return { ok: false, reason: "parse_failed" };
    }

    // evals[i] is the position AFTER ply i was played, from White's perspective.
    const counts = { genius: 0, best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    const moveResults = [];
    for (let i = 0; i < plies.length && i < evals.length; i++) {
      const ply = plies[i];
      const userSideChar = side === "white" ? "white" : side === "black" ? "black" : null;
      if (userSideChar && ply.side !== userSideChar) continue;
      const before = i === 0 ? 0 : evals[i - 1];
      const after = evals[i];
      const sign = ply.side === "white" ? 1 : -1;
      const cpLoss = (before * sign) - (after * sign);
      const bucket = bucketFromCpLoss(cpLoss);
      counts[bucket]++;
      moveResults.push({ san: ply.san, cpLoss, bucket });
    }
    console.log("Lichess: final counts", counts);
    return { ok: true, counts, moveResults };
  } catch (e) {
    console.error("Lichess: uncaught error during export fetch:", e);
    return { ok: false, reason: "network" };
  }
}

// Stockfish worker singleton — created lazily on first use so pages that never touch
// engine analysis don't pay the download/init cost.
let _sfWorker = null;
let _sfReady = null;

function getStockfishWorker() {
  if (_sfWorker) return _sfReady;
  _sfReady = new Promise((resolve, reject) => {
    try {
      // Confirmed on npmjs.com/package/stockfish: version 18.x ships fixed (non-hashed)
      // filenames — stockfish-18-lite-single.js is the lite single-threaded WASM build,
      // ~7MB, runs without special CORS/COEP headers. Pinned to 18.0.0 rather than "latest"
      // so the filename contract doesn't shift under us again.
      const workerUrl = "https://unpkg.com/stockfish@18.0.0/src/stockfish-18-lite-single.js";

      // Browsers block `new Worker(crossOriginUrl)` directly (same-origin policy on Worker
      // construction). The standard workaround: create the worker from a same-origin Blob
      // whose only content is `importScripts(absoluteUrl)` — importScripts() is allowed to
      // load cross-origin scripts from inside a worker context, and the Stockfish script's
      // own internal fetch of its companion .wasm file resolves against that original CDN
      // URL correctly (not against the blob: URL).
      const bootstrap = `importScripts(${JSON.stringify(workerUrl)});`;
      const blob = new Blob([bootstrap], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      const worker = new Worker(blobUrl);
      let handshakeDone = false;

      worker.addEventListener("error", (err) => {
        console.error("Stockfish worker error (script load or runtime):", err.message || err, "URL:", workerUrl);
        if (!handshakeDone) reject(err);
      });

      const onFirstMessage = (e) => {
        if (String(e.data).includes("uciok") || String(e.data).includes("Stockfish")) {
          handshakeDone = true;
          console.log("Stockfish handshake OK:", e.data);
          worker.removeEventListener("message", onFirstMessage);
          resolve(worker);
        }
      };
      worker.addEventListener("message", onFirstMessage);
      worker.postMessage("uci");
      _sfWorker = worker;
      // Safety fallback: some builds respond with different handshake text than expected.
      // If we haven't resolved by 4s, log it clearly instead of silently proceeding —
      // this makes "engine loaded but never spoke" visible and distinguishable from
      // "engine failed to load at all" (which fires the error listener above instead).
      setTimeout(() => {
        if (!handshakeDone) {
          console.warn("Stockfish handshake timeout — proceeding anyway, but engine may not respond correctly.");
          resolve(worker);
        }
      }, 4000);
    } catch (err) {
      reject(err);
    }
  });
  return _sfReady;
}

// Evaluates a single FEN position with Stockfish, returns centipawn score from White's
// perspective (positive = White better), or null on mate-in-N scores converted to a large number.
function evalPositionWithWorker(worker, fen, depth = 10) {
  return new Promise((resolve) => {
    let resolved = false;
    const onMessage = (e) => {
      const line = typeof e.data === "string" ? e.data : "";
      const mateMatch = line.match(/score mate (-?\d+)/);
      const cpMatch = line.match(/score cp (-?\d+)/);
      if (line.startsWith("bestmove")) {
        if (!resolved) {
          resolved = true;
          worker.removeEventListener("message", onMessage);
          resolve(lastScore);
        }
        return;
      }
      if (mateMatch) lastScore = (parseInt(mateMatch[1], 10) > 0 ? 1 : -1) * 10000;
      else if (cpMatch) lastScore = parseInt(cpMatch[1], 10);
    };
    let lastScore = 0;
    worker.addEventListener("message", onMessage);
    worker.postMessage("position fen " + fen);
    worker.postMessage("go depth " + depth);
    // Safety timeout per position so one stuck eval doesn't hang the whole game analysis.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        worker.removeEventListener("message", onMessage);
        resolve(lastScore);
      }
    }, 3000);
  });
}

// Replays a PGN through chess.js move-by-move, producing { san, fenBefore, fenAfter, side } per ply.
// Requires the global `Chess` constructor from the chess.js CDN script.
function buildPlyList(rawPgn) {
  if (typeof Chess === "undefined") return null;
  // chess.js 0.12.0 uses snake_case method names (load_pgn, not loadPgn as in later 1.x betas).
  const chess = new Chess();
  const loaded = chess.load_pgn ? chess.load_pgn(rawPgn) : false;
  if (loaded === false) return null;
  const history = chess.history({ verbose: true });
  if (!history || history.length === 0) return null;

  const replay = new Chess();
  const plies = [];
  history.forEach((mv) => {
    const fenBefore = replay.fen();
    replay.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    const fenAfter = replay.fen();
    plies.push({ san: mv.san, fenBefore, fenAfter, side: mv.color === "w" ? "white" : "black" });
  });
  return plies;
}

// Classifies centipawn loss into the same bucket vocabulary used elsewhere in the app.
function bucketFromCpLoss(cpLoss) {
  if (cpLoss >= 300) return "blunder";
  if (cpLoss >= 150) return "mistake";
  if (cpLoss >= 60) return "inaccuracy";
  if (cpLoss <= -120) return "genius"; // move gained significant advantage vs engine expectation
  if (cpLoss <= 0) return "best";
  return "good";
}

// Runs a full local Stockfish analysis over a PGN, returning per-user-move classification
// counts plus a flat array of { san, cpLoss, bucket } for the user's own moves only.
// Progress callback receives (currentPly, totalPlies) for UI feedback.
async function analyzeWithStockfish(rawPgn, side, onProgress) {
  const plies = buildPlyList(rawPgn);
  if (!plies) {
    console.error("Stockfish analysis: buildPlyList failed — PGN could not be parsed by chess.js. Is `Chess` defined?", typeof Chess);
    return { ok: false, reason: "parse_failed" };
  }

  let worker;
  try {
    worker = await getStockfishWorker();
  } catch (e) {
    console.error("Stockfish analysis: worker failed to initialize.", e);
    return { ok: false, reason: "worker_failed" };
  }

  const results = [];
  const userSideChar = side === "white" ? "white" : side === "black" ? "black" : null;

  for (let i = 0; i < plies.length; i++) {
    const ply = plies[i];
    if (userSideChar && ply.side !== userSideChar) {
      onProgress && onProgress(i + 1, plies.length);
      continue;
    }
    const evalBefore = await evalPositionWithWorker(worker, ply.fenBefore, 10);
    const evalAfter = await evalPositionWithWorker(worker, ply.fenAfter, 10);
    // Normalize both evals to "how good for the side who just moved"
    const sign = ply.side === "white" ? 1 : -1;
    const before = evalBefore * sign;
    const after = -evalAfter * sign; // after the move, eval is reported from other side's turn
    const cpLoss = before - after;
    results.push({ san: ply.san, cpLoss, bucket: bucketFromCpLoss(cpLoss) });
    onProgress && onProgress(i + 1, plies.length);
  }

  const counts = { genius: 0, best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  results.forEach((r) => counts[r.bucket]++);

  return { ok: true, counts, moveResults: results };
}

// ---------- KPI computation ----------
function computeGameKPIs(game, resolvedSide, externalCounts) {
  const { moves, tags } = game.parsed;
  const mine = userMoves(moves, resolvedSide);
  const counts = externalCounts || classifyMoves(mine);
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const errorWeight = counts.blunder * 3 + counts.mistake * 2 + counts.inaccuracy * 1;
  const errorRate = errorWeight / total;

  // Phase split: when we have externally-computed per-move buckets (Stockfish), we don't
  // currently carry ply-order metadata through externalCounts, so phase breakdown still
  // uses the annotation-based approximation on the user's move subset. This is a known
  // simplification — good enough for "which third of the game is weakest" at a glance.
  const phases = { opening: mine.slice(0, 6), middlegame: mine.slice(6, 16), endgame: mine.slice(16) };
  const phaseErr = {};
  Object.entries(phases).forEach(([k, arr]) => {
    const c = classifyMoves(arr);
    const t = Object.values(c).reduce((a, b) => a + b, 0) || 1;
    phaseErr[k] = (c.blunder * 3 + c.mistake * 2 + c.inaccuracy) / t;
  });
  const weakestPhase = Object.entries(phaseErr).sort((a, b) => b[1] - a[1])[0]?.[0] || "middlegame";
  return { counts, errorRate, phaseErr, weakestPhase, totalMoves: total };
}

function aggregateKPIs(games) {
  if (games.length === 0) return null;
  const byOpening = {};
  let wins = 0, losses = 0, draws = 0, totalErrorRate = 0;
  const phaseAgg = { opening: [], middlegame: [], endgame: [] };
  games.forEach((g) => {
    const fam = openingFamily(g.parsed.tags.Opening || g.parsed.tags.ECO);
    const result = detectResult(g.parsed.tags, g.resolvedSide);
    if (!byOpening[fam]) byOpening[fam] = { games: 0, wins: 0, losses: 0, draws: 0, errorRateSum: 0 };
    byOpening[fam].games++;
    if (result.outcome === "vitória") { byOpening[fam].wins++; wins++; }
    else if (result.outcome === "derrota") { byOpening[fam].losses++; losses++; }
    else if (result.outcome === "empate") { byOpening[fam].draws++; draws++; }
    byOpening[fam].errorRateSum += g.kpis.errorRate;
    totalErrorRate += g.kpis.errorRate;
    Object.entries(g.kpis.phaseErr).forEach(([k, v]) => phaseAgg[k].push(v));
  });
  const avgPhaseErr = {};
  Object.entries(phaseAgg).forEach(([k, arr]) => { avgPhaseErr[k] = arr.reduce((a, b) => a + b, 0) / (arr.length || 1); });
  const openingStats = Object.entries(byOpening).map(([name, s]) => ({
    name, games: s.games, winRate: s.wins / s.games, lossRate: s.losses / s.games, avgErrorRate: s.errorRateSum / s.games,
  })).sort((a, b) => b.games - a.games);
  return {
    totalGames: games.length, wins, losses, draws, winPct: wins / games.length,
    avgErrorRate: totalErrorRate / games.length, avgPhaseErr,
    weakestPhaseOverall: Object.entries(avgPhaseErr).sort((a, b) => b[1] - a[1])[0][0],
    openingStats,
  };
}

function generateTips(agg, games) {
  if (!agg || games.length === 0) return [];
  const tips = [];
  const phaseNames = { opening: "abertura", middlegame: "meio-jogo", endgame: "final" };
  const wp = agg.weakestPhaseOverall;
  tips.push({
    title: `Foco de treino: ${phaseNames[wp]}`,
    body: `Sua taxa de erro ponderada é mais alta no ${phaseNames[wp]} (${(agg.avgPhaseErr[wp] * 100).toFixed(1)}%) comparado às outras fases. Isso indica onde seus pontos perdidos se concentram.`,
    action: wp === "opening" ? "Prática recomendada: puzzles de abertura com tempo curto — 15 min/dia."
      : wp === "middlegame" ? "Prática recomendada: puzzles táticos temáticos (garfos, cravadas, ataques duplos)."
      : "Prática recomendada: finais de peão e torre básicos.",
  });
  const viable = agg.openingStats.filter((o) => o.games >= 2);
  const best = viable.sort((a, b) => b.winRate - a.winRate)[0];
  if (best) {
    tips.push({
      title: `Sua melhor abertura: ${best.name}`,
      body: `Em ${best.games} partida(s), você tem ${(best.winRate * 100).toFixed(0)}% de vitórias e erro médio de ${(best.avgErrorRate * 100).toFixed(1)}%.`,
      action: "Sugestão: aprofunde essa linha em vez de diversificar repertório agora.",
    });
  }
  const worst = viable.sort((a, b) => a.winRate - b.winRate)[0];
  if (worst && worst.name !== best?.name) {
    tips.push({
      title: `Abertura a revisar: ${worst.name}`,
      body: `Taxa de vitória de ${(worst.winRate * 100).toFixed(0)}% e erro médio de ${(worst.avgErrorRate * 100).toFixed(1)}% em ${worst.games} partidas.`,
      action: "Sugestão: estude a fundo ou evite temporariamente até fechar o gap de erro.",
    });
  }
  const totalBlunders = games.reduce((sum, g) => sum + g.kpis.counts.blunder, 0);
  const totalGenius = games.reduce((sum, g) => sum + g.kpis.counts.genius, 0);
  if (totalBlunders > 0) {
    tips.push({
      title: `Controle de erro grave`,
      body: `${totalBlunders} erro(s) grave(s) (??) contra ${totalGenius} lance(s) geniais (!!) — capacidade tática alta, mas inconsistente.`,
      action: "Sugestão: antes de cada lance não-forçado, pergunte 'o que meu oponente ameaça se eu não fizer nada'.",
    });
  } else {
    tips.push({
      title: `Consistência tática`,
      body: `Nenhum erro grave registrado — sinal forte de disciplina tática.`,
      action: "Sugestão: suba o nível dos oponentes para achar seu teto real.",
    });
  }
  if (games.length >= 3) {
    const sorted = [...games].sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt));
    const half = Math.floor(sorted.length / 2);
    const firstHalfErr = sorted.slice(0, half).reduce((s, g) => s + g.kpis.errorRate, 0) / (half || 1);
    const secondHalfErr = sorted.slice(half).reduce((s, g) => s + g.kpis.errorRate, 0) / (sorted.length - half || 1);
    const improving = secondHalfErr < firstHalfErr;
    tips.push({
      title: improving ? "Tendência de melhora confirmada" : "Tendência de erro subindo",
      body: improving
        ? `Erro caiu de ${(firstHalfErr * 100).toFixed(1)}% para ${(secondHalfErr * 100).toFixed(1)}%.`
        : `Erro subiu de ${(firstHalfErr * 100).toFixed(1)}% para ${(secondHalfErr * 100).toFixed(1)}%.`,
      action: improving ? "Sugestão: suba a dificuldade do oponente gradualmente." : "Sugestão: reduza volume por sessão por 1-2 semanas.",
    });
  } else {
    tips.push({
      title: "Volume de dados ainda baixo",
      body: `Com ${games.length} partida(s), tendências ainda não são confiáveis.`,
      action: "Sugestão: adicione pelo menos 5-10 partidas.",
    });
  }
  return tips.slice(0, 5);
}

// ---------- UI subcomponents ----------
function Stat({ label, value, accent }) {
  return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
    React.createElement("span", { style: { fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: C.inkFaint } }, label),
    React.createElement("span", { style: { fontFamily: "Georgia, serif", fontSize: 28, color: accent || C.ink, fontVariantNumeric: "tabular-nums" } }, value)
  );
}

function Pill({ children, tone }) {
  const bg = tone === "good" ? "rgba(111,174,127,0.15)" : tone === "bad" ? "rgba(181,83,60,0.15)" : "rgba(201,162,75,0.12)";
  const fg = tone === "good" ? C.feltBright : tone === "bad" ? C.rustBright : C.brass;
  return React.createElement("span", { style: { background: bg, color: fg, padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 } }, children);
}

function Bar({ pct, tone }) {
  const fg = tone === "good" ? C.feltBright : tone === "bad" ? C.rustBright : C.brass;
  return React.createElement("div", { style: { width: "100%", height: 6, background: C.line, borderRadius: 3, overflow: "hidden" } },
    React.createElement("div", { style: { width: `${Math.min(100, pct * 100)}%`, height: "100%", background: fg, borderRadius: 3, transition: "width 0.4s ease" } })
  );
}

function SectionLabel({ children }) {
  return React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 } },
    React.createElement("span", { style: { width: 8, height: 8, background: C.brass, borderRadius: 1, transform: "rotate(45deg)" } }),
    React.createElement("span", { style: { fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: C.inkFaint, fontWeight: 600 } }, children)
  );
}

function GameRow({ game, onClick }) {
  const result = detectResult(game.parsed.tags, game.resolvedSide);
  const tone = result.outcome === "vitória" ? "good" : result.outcome === "derrota" ? "bad" : "neutral";
  return React.createElement("button", {
    onClick, style: { display: "flex", justifyContent: "space-between", alignItems: "center", background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "12px 16px", cursor: "pointer", textAlign: "left", width: "100%", color: C.ink }
  },
    React.createElement("div", null,
      React.createElement("div", { style: { fontSize: 13.5, fontWeight: 600 } }, `${game.parsed.tags.White || "?"} vs ${game.parsed.tags.Black || "?"}`),
      React.createElement("div", { style: { fontSize: 12, color: C.inkFaint, marginTop: 2 } }, `${openingFamily(game.parsed.tags.Opening || game.parsed.tags.ECO || "Abertura desconhecida")} · ${game.source}`)
    ),
    React.createElement(Pill, { tone }, result.outcome)
  );
}

function DashboardView({ games, agg, agg20, last20, tips, onGoAdd, onGoHistory, onSelectGame }) {
  if (games.length === 0) {
    return React.createElement("div", { style: { textAlign: "center", padding: "60px 20px", border: `1px dashed ${C.line}`, borderRadius: 10 } },
      React.createElement("p", { style: { fontFamily: "Georgia, serif", fontSize: 20, marginBottom: 8 } }, "Nenhuma partida ainda"),
      React.createElement("p", { style: { color: C.inkDim, fontSize: 14, marginBottom: 20 } }, "Adicione seu primeiro PGN para começar a ver KPIs reais."),
      React.createElement("button", { onClick: onGoAdd, style: { background: C.brass, color: C.bg, border: "none", borderRadius: 6, padding: "10px 20px", fontWeight: 700, cursor: "pointer" } }, "Adicionar partida")
    );
  }
  const phaseLabels = { opening: "Abertura", middlegame: "Meio-jogo", endgame: "Final" };
  return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 32 } },
    React.createElement("div", null,
      React.createElement(SectionLabel, null, `Últimas ${last20.length} partidas`),
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16, background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 20 } },
        React.createElement(Stat, { label: "Taxa de vitória", value: `${(agg20.winPct * 100).toFixed(0)}%`, accent: C.feltBright }),
        React.createElement(Stat, { label: "V / E / D", value: `${agg20.wins}/${agg20.draws}/${agg20.losses}` }),
        React.createElement(Stat, { label: "Erro médio ponderado", value: `${(agg20.avgErrorRate * 100).toFixed(1)}%`, accent: agg20.avgErrorRate > 0.15 ? C.rustBright : C.feltBright }),
        React.createElement(Stat, { label: "Fase mais fraca", value: phaseLabels[agg20.weakestPhaseOverall], accent: C.brass })
      )
    ),
    React.createElement("div", null,
      React.createElement(SectionLabel, null, `Erro por fase (últimas ${last20.length})`),
      React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14, background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 20 } },
        Object.entries(phaseLabels).map(([key, label]) => {
          const v = agg20.avgPhaseErr[key];
          const isWorst = key === agg20.weakestPhaseOverall;
          return React.createElement("div", { key },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 } },
              React.createElement("span", { style: { color: isWorst ? C.rustBright : C.inkDim, fontWeight: isWorst ? 700 : 400 } }, label),
              React.createElement("span", { style: { color: C.inkFaint, fontVariantNumeric: "tabular-nums" } }, `${(v * 100).toFixed(1)}%`)
            ),
            React.createElement(Bar, { pct: v * 4, tone: isWorst ? "bad" : "neutral" })
          );
        })
      )
    ),
    React.createElement("div", null,
      React.createElement(SectionLabel, null, "5 recomendações práticas"),
      React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        tips.map((tip, i) => React.createElement("div", { key: i, style: { background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 18 } },
          React.createElement("div", { style: { display: "flex", gap: 12, alignItems: "flex-start" } },
            React.createElement("span", { style: { fontFamily: "Georgia, serif", fontSize: 18, color: C.brass, width: 28, height: 28, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${C.brassDim}`, borderRadius: "50%" } }, i + 1),
            React.createElement("div", { style: { flex: 1 } },
              React.createElement("p", { style: { fontWeight: 700, fontSize: 15, margin: "2px 0 6px" } }, tip.title),
              React.createElement("p", { style: { color: C.inkDim, fontSize: 13.5, lineHeight: 1.6, margin: "0 0 8px" } }, tip.body),
              React.createElement("p", { style: { color: C.feltBright, fontSize: 13, fontWeight: 600, margin: 0 } }, `→ ${tip.action}`)
            )
          )
        ))
      )
    ),
    React.createElement("div", null,
      React.createElement(SectionLabel, null, `Desempenho por abertura (todas as ${games.length} partidas)`),
      React.createElement("div", { style: { background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" } },
        React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 13 } },
          React.createElement("thead", null,
            React.createElement("tr", { style: { borderBottom: `1px solid ${C.line}`, color: C.inkFaint, textAlign: "left" } },
              ["Abertura", "Jogos", "Vitórias", "Erro médio"].map((h) => React.createElement("th", { key: h, style: { padding: "10px 16px", fontWeight: 600, fontSize: 11, textTransform: "uppercase" } }, h))
            )
          ),
          React.createElement("tbody", null,
            agg.openingStats.map((o) => React.createElement("tr", { key: o.name, style: { borderBottom: `1px solid ${C.line}` } },
              React.createElement("td", { style: { padding: "10px 16px" } }, o.name),
              React.createElement("td", { style: { padding: "10px 16px", color: C.inkDim } }, o.games),
              React.createElement("td", { style: { padding: "10px 16px" } }, React.createElement(Pill, { tone: o.winRate >= 0.5 ? "good" : "bad" }, `${(o.winRate * 100).toFixed(0)}%`)),
              React.createElement("td", { style: { padding: "10px 16px", color: o.avgErrorRate > 0.15 ? C.rustBright : C.inkDim } }, `${(o.avgErrorRate * 100).toFixed(1)}%`)
            ))
          )
        )
      )
    ),
    React.createElement("div", null,
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        React.createElement(SectionLabel, null, "Partidas recentes"),
        React.createElement("button", { onClick: onGoHistory, style: { background: "none", border: "none", color: C.brass, fontSize: 12.5, cursor: "pointer", fontWeight: 600 } }, "Ver histórico completo →")
      ),
      React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
        [...games].slice(-5).reverse().map((g) => React.createElement(GameRow, { key: g.id, game: g, onClick: () => onSelectGame(g.id) }))
      )
    )
  );
}

function AddGameView({ pgnInput, setPgnInput, source, setSource, engineMode, setEngineMode, onAdd, analyzing, status }) {
  const labelStyle = { fontSize: 12, letterSpacing: "0.05em", textTransform: "uppercase", color: C.inkFaint, marginBottom: 8, display: "block", fontWeight: 600 };
  const selectStyle = { width: "100%", background: C.bgPanel2, border: `1px solid ${C.line}`, borderRadius: 6, color: C.ink, padding: "10px 12px", fontSize: 14 };
  return React.createElement("div", { style: { maxWidth: 640, margin: "0 auto" } },
    React.createElement("p", { style: { fontFamily: "Georgia, serif", fontSize: 22, marginBottom: 4 } }, "Adicionar partida"),
    React.createElement("p", { style: { color: C.inkDim, fontSize: 13.5, marginBottom: 24 } }, "Cole o PGN de qualquer fonte — Chessis, Lichess, Chess.com ou manual."),
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 } },
      React.createElement("div", null,
        React.createElement("label", { style: labelStyle }, "Fonte"),
        React.createElement("select", { value: source, onChange: (e) => setSource(e.target.value), style: selectStyle },
          React.createElement("option", { value: "chessis" }, "Chessis"),
          React.createElement("option", { value: "lichess" }, "Lichess"),
          React.createElement("option", { value: "chesscom" }, "Chess.com"),
          React.createElement("option", { value: "manual" }, "PGN manual")
        )
      ),
      React.createElement("div", null,
        React.createElement("label", { style: labelStyle }, "Modo de análise"),
        React.createElement("select", { value: engineMode, onChange: (e) => setEngineMode(e.target.value), style: selectStyle },
          React.createElement("option", { value: "none" }, "Sem engine (usa anotações do PGN)"),
          React.createElement("option", { value: "lichess-cloud" }, "API do Lichess (semi-manual)"),
          React.createElement("option", { value: "stockfish-js" }, "Stockfish.js no navegador")
        )
      )
    ),
    React.createElement("label", { style: labelStyle }, "PGN"),
    React.createElement("textarea", {
      value: pgnInput, onChange: (e) => setPgnInput(e.target.value),
      placeholder: '[Event "..."]\n1. e4 c5 2. b3 ...', rows: 12,
      style: { width: "100%", background: C.bgPanel2, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, padding: 14, fontFamily: "monospace", fontSize: 13, resize: "vertical", marginBottom: 16 }
    }),
    status && React.createElement("div", {
      style: { padding: "10px 14px", borderRadius: 6, marginBottom: 16, fontSize: 13, background: status.ok ? "rgba(111,174,127,0.12)" : "rgba(181,83,60,0.12)", color: status.ok ? C.feltBright : C.rustBright }
    }, status.msg),
    React.createElement("button", {
      onClick: onAdd, disabled: analyzing,
      style: { background: analyzing ? C.brassDim : C.brass, color: C.bg, border: "none", borderRadius: 6, padding: "12px 24px", fontWeight: 700, fontSize: 14, cursor: analyzing ? "default" : "pointer", width: "100%" }
    }, analyzing ? "Analisando…" : "Adicionar e analisar"),
    React.createElement("p", { style: { fontSize: 12, color: C.inkFaint, marginTop: 12, lineHeight: 1.6 } },
      "Nota sobre engines: o modo \"sem engine\" usa as anotações (!!, !, ?!, ?, ??) já presentes no PGN — rápido, mas só funciona se a fonte já anotou (Chessis faz isso; PGN cru do Chess.com/Lichess geralmente não). O modo Stockfish.js roda análise real, local no navegador — mais lento, mas totalmente automático. O modo Lichess é semi-manual: a API do Lichess não tem como acionar a análise sozinha, então depois de importar a partida, você mesmo abre o link, clica em \"Request a computer analysis\" no site, espera terminar, e volta aqui para buscar o resultado."
    )
  );
}

function HistoryView({ games, onSelect, onDelete }) {
  if (games.length === 0) return React.createElement("p", { style: { color: C.inkDim, textAlign: "center", padding: 40 } }, "Nenhuma partida registrada ainda.");
  return React.createElement("div", null,
    React.createElement("p", { style: { fontFamily: "Georgia, serif", fontSize: 22, marginBottom: 20 } }, `Histórico completo (${games.length})`),
    React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      [...games].reverse().map((g) => {
        const result = detectResult(g.parsed.tags, g.resolvedSide);
        const tone = result.outcome === "vitória" ? "good" : result.outcome === "derrota" ? "bad" : "neutral";
        return React.createElement("div", { key: g.id, style: { display: "flex", justifyContent: "space-between", alignItems: "center", background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "12px 16px" } },
          React.createElement("button", { onClick: () => onSelect(g.id), style: { background: "none", border: "none", color: C.ink, textAlign: "left", cursor: "pointer", flex: 1 } },
            React.createElement("div", { style: { fontSize: 13.5, fontWeight: 600 } }, `${g.parsed.tags.White || "?"} vs ${g.parsed.tags.Black || "?"}`),
            React.createElement("div", { style: { fontSize: 12, color: C.inkFaint, marginTop: 2 } }, `${new Date(g.addedAt).toLocaleDateString("pt-BR")} · ${g.source} · erro ${(g.kpis.errorRate * 100).toFixed(1)}%`)
          ),
          React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
            React.createElement(Pill, { tone }, result.outcome),
            React.createElement("button", { onClick: () => onDelete(g.id), style: { background: "none", border: `1px solid ${C.line}`, color: C.rustBright, borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer" } }, "Remover")
          )
        );
      })
    )
  );
}

function GameDetailView({ game, onBack }) {
  const result = detectResult(game.parsed.tags, game.resolvedSide);
  const { counts, errorRate, phaseErr, weakestPhase } = game.kpis;
  const phaseNames = { opening: "Abertura", middlegame: "Meio-jogo", endgame: "Final" };
  const rows = [
    ["genius", "Gênio (!!)", C.brass], ["best", "Preciso (!)", C.feltBright], ["good", "Bom", C.sky],
    ["inaccuracy", "Imprecisão (?!)", "#c9974b"], ["mistake", "Erro (?)", C.rustBright], ["blunder", "Erro grave (??)", "#8a2f1f"],
  ];
  return React.createElement("div", null,
    React.createElement("button", { onClick: onBack, style: { background: "none", border: "none", color: C.brass, fontSize: 13, cursor: "pointer", marginBottom: 16, fontWeight: 600 } }, "← Voltar"),
    React.createElement("p", { style: { fontFamily: "Georgia, serif", fontSize: 22, marginBottom: 4 } }, `${game.parsed.tags.White || "?"} vs ${game.parsed.tags.Black || "?"}`),
    React.createElement("p", { style: { color: C.inkDim, fontSize: 13.5, marginBottom: 20 } }, `${openingFamily(game.parsed.tags.Opening || game.parsed.tags.ECO)} · ${new Date(game.addedAt).toLocaleDateString("pt-BR")} · Resultado: ${result.outcome}`),
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px,1fr))", gap: 16, background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 20, marginBottom: 20 } },
      React.createElement(Stat, { label: "Erro ponderado", value: `${(errorRate * 100).toFixed(1)}%`, accent: errorRate > 0.15 ? C.rustBright : C.feltBright }),
      React.createElement(Stat, { label: "Lances geniais", value: counts.genius, accent: C.brass }),
      React.createElement(Stat, { label: "Erros graves", value: counts.blunder, accent: counts.blunder > 0 ? C.rustBright : C.feltBright }),
      React.createElement(Stat, { label: "Fase mais fraca", value: phaseNames[weakestPhase] })
    ),
    React.createElement(SectionLabel, null, "Distribuição de lances"),
    React.createElement("div", { style: { background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 20, marginBottom: 20 } },
      rows.map(([key, label, color]) => React.createElement("div", { key, style: { display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13.5 } },
        React.createElement("span", { style: { color: C.inkDim } }, label),
        React.createElement("span", { style: { color, fontWeight: 700 } }, counts[key])
      ))
    ),
    React.createElement(SectionLabel, null, "Erro por fase"),
    React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12, background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 20, marginBottom: 20 } },
      Object.entries(phaseErr).map(([key, v]) => React.createElement("div", { key },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 } },
          React.createElement("span", { style: { color: key === weakestPhase ? C.rustBright : C.inkDim, fontWeight: key === weakestPhase ? 700 : 400 } }, phaseNames[key]),
          React.createElement("span", { style: { color: C.inkFaint } }, `${(v * 100).toFixed(1)}%`)
        ),
        React.createElement(Bar, { pct: v * 4, tone: key === weakestPhase ? "bad" : "neutral" })
      ))
    ),
    React.createElement(SectionLabel, null, "Nota de análise"),
    React.createElement("p", { style: { color: C.inkDim, fontSize: 13.5, lineHeight: 1.6, background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16 } }, game.engineNote)
  );
}

function SideChoiceModal({ tags, onChoose, onCancel }) {
  return React.createElement("div", {
    style: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000, padding: 20 }
  },
    React.createElement("div", { style: { background: C.bgPanel, border: `1px solid ${C.brassDim}`, borderRadius: 10, padding: 24, maxWidth: 420, width: "100%" } },
      React.createElement("p", { style: { fontFamily: "Georgia, serif", fontSize: 18, marginBottom: 10 } }, "Qual lado você jogou?"),
      React.createElement("p", { style: { color: C.inkDim, fontSize: 13.5, marginBottom: 18, lineHeight: 1.6 } },
        `Não reconheci automaticamente pelo PGN. Brancas: "${tags.White || "?"}" · Pretas: "${tags.Black || "?"}". Escolha seu lado nesta partida — isso não muda seu usuário salvo.`
      ),
      React.createElement("div", { style: { display: "flex", gap: 10, marginBottom: 12 } },
        React.createElement("button", {
          onClick: () => onChoose("white"),
          style: { flex: 1, background: C.brass, color: C.bg, border: "none", borderRadius: 6, padding: "12px 14px", fontWeight: 700, cursor: "pointer" }
        }, `Brancas (${tags.White || "?"})`),
        React.createElement("button", {
          onClick: () => onChoose("black"),
          style: { flex: 1, background: C.felt, color: C.bg, border: "none", borderRadius: 6, padding: "12px 14px", fontWeight: 700, cursor: "pointer" }
        }, `Pretas (${tags.Black || "?"})`)
      ),
      React.createElement("button", {
        onClick: onCancel,
        style: { width: "100%", background: "none", border: `1px solid ${C.line}`, color: C.inkDim, borderRadius: 6, padding: "9px 14px", fontSize: 13, cursor: "pointer" }
      }, "Cancelar")
    )
  );
}

function SettingsView({ settings, onSave }) {
  const [newUsername, setNewUsername] = useState("");
  const usernames = settings.usernames || [];

  const addUsername = () => {
    const trimmed = newUsername.trim();
    if (!trimmed) return;
    if (usernames.some((u) => u.toLowerCase() === trimmed.toLowerCase())) { setNewUsername(""); return; }
    onSave({ ...settings, usernames: [...usernames, trimmed] });
    setNewUsername("");
  };

  const removeUsername = (u) => {
    onSave({ ...settings, usernames: usernames.filter((x) => x !== u) });
  };

  const labelStyle = { fontSize: 12, letterSpacing: "0.05em", textTransform: "uppercase", color: C.inkFaint, marginBottom: 8, display: "block", fontWeight: 600 };

  return React.createElement("div", { style: { maxWidth: 560, margin: "0 auto" } },
    React.createElement("p", { style: { fontFamily: "Georgia, serif", fontSize: 22, marginBottom: 4 } }, "Configurações"),
    React.createElement("p", { style: { color: C.inkDim, fontSize: 13.5, marginBottom: 24, lineHeight: 1.6 } },
      "Salve seus usernames de Lichess, Chess.com etc. O app usa essa lista para identificar automaticamente qual lado (brancas/pretas) é você em PGNs que não dizem \"Você\" explicitamente. Quando o username não bate com nenhum salvo, o app pergunta na hora."
    ),
    React.createElement("label", { style: labelStyle }, "Adicionar username"),
    React.createElement("div", { style: { display: "flex", gap: 8, marginBottom: 20 } },
      React.createElement("input", {
        value: newUsername, onChange: (e) => setNewUsername(e.target.value),
        onKeyDown: (e) => { if (e.key === "Enter") addUsername(); },
        placeholder: "ex: bkskyline123",
        style: { flex: 1, background: C.bgPanel2, border: `1px solid ${C.line}`, borderRadius: 6, color: C.ink, padding: "10px 12px", fontSize: 14 }
      }),
      React.createElement("button", {
        onClick: addUsername,
        style: { background: C.brass, color: C.bg, border: "none", borderRadius: 6, padding: "10px 18px", fontWeight: 700, cursor: "pointer" }
      }, "Adicionar")
    ),
    React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      usernames.length === 0
        ? React.createElement("p", { style: { color: C.inkFaint, fontSize: 13 } }, "Nenhum username salvo ainda.")
        : usernames.map((u) => React.createElement("div", {
            key: u, style: { display: "flex", justifyContent: "space-between", alignItems: "center", background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 14px" }
          },
            React.createElement("span", { style: { fontSize: 13.5 } }, u),
            React.createElement("button", {
              onClick: () => removeUsername(u),
              style: { background: "none", border: `1px solid ${C.line}`, color: C.rustBright, borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }
            }, "Remover")
          ))
    )
  );
}

function LichessPendingModal({ pending, status, onFetch, onCancel }) {
  return React.createElement("div", {
    style: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000, padding: 20 }
  },
    React.createElement("div", { style: { background: C.bgPanel, border: `1px solid ${C.brassDim}`, borderRadius: 10, padding: 24, maxWidth: 460, width: "100%" } },
      React.createElement("p", { style: { fontFamily: "Georgia, serif", fontSize: 18, marginBottom: 10 } }, "Partida importada no Lichess"),
      React.createElement("p", { style: { color: C.inkDim, fontSize: 13.5, marginBottom: 16, lineHeight: 1.6 } },
        "O Lichess não permite acionar a análise automaticamente por API — só pelo site. Siga os passos:"
      ),
      React.createElement("ol", { style: { color: C.inkDim, fontSize: 13.5, lineHeight: 1.9, marginBottom: 18, paddingLeft: 20 } },
        React.createElement("li", null,
          "Abra a partida: ",
          React.createElement("a", { href: pending.url, target: "_blank", rel: "noopener noreferrer", style: { color: C.brass, fontWeight: 700 } }, pending.url)
        ),
        React.createElement("li", null, "Clique em \"Request a computer analysis\" (ou \"Análise do computador\")"),
        React.createElement("li", null, "Espere terminar (geralmente ~30-60s)"),
        React.createElement("li", null, "Volte aqui e clique em \"Buscar análise\" abaixo")
      ),
      status && React.createElement("div", {
        style: { padding: "10px 14px", borderRadius: 6, marginBottom: 14, fontSize: 13, background: status.loading ? "rgba(201,162,75,0.12)" : "rgba(181,83,60,0.12)", color: status.loading ? C.brass : C.rustBright }
      }, status.loading ? "Buscando análise…" : status.msg),
      React.createElement("div", { style: { display: "flex", gap: 10 } },
        React.createElement("button", {
          onClick: onFetch,
          disabled: status && status.loading,
          style: { flex: 1, background: C.brass, color: C.bg, border: "none", borderRadius: 6, padding: "12px 14px", fontWeight: 700, cursor: status && status.loading ? "default" : "pointer" }
        }, status && status.loading ? "Buscando…" : "Buscar análise"),
        React.createElement("button", {
          onClick: onCancel,
          style: { background: "none", border: `1px solid ${C.line}`, color: C.inkDim, borderRadius: 6, padding: "12px 14px", fontSize: 13, cursor: "pointer" }
        }, "Cancelar")
      )
    )
  );
}

function App() {
  const [games, setGames] = useState(loadGames());
  const [settings, setSettings] = useState(loadSettings());
  const [tab, setTab] = useState("dashboard");
  const [pgnInput, setPgnInput] = useState("");
  const [source, setSource] = useState("chessis");
  const [engineMode, setEngineMode] = useState("none");
  const [selectedGameId, setSelectedGameId] = useState(null);
  const [addStatus, setAddStatus] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(null);
  // When side detection fails, we stash the pending add here and ask the user to pick.
  const [pendingSideChoice, setPendingSideChoice] = useState(null);
  // Lichess semi-manual flow: after import, the person must open the Lichess link,
  // click "Request a computer analysis" themselves (no public API for that action),
  // wait for it to finish, then come back and click "Buscar análise" to complete the save.
  const [pendingLichessImport, setPendingLichessImport] = useState(null);
  const [lichessFetchStatus, setLichessFetchStatus] = useState(null);

  const persist = useCallback((next) => { setGames(next); saveGames(next); }, []);
  const persistSettings = useCallback((next) => { setSettings(next); saveSettings(next); }, []);

  const saveGameWithCounts = (pgnText, resolvedSide, externalCounts, engineNote) => {
    const parsed = parsePGN(pgnText);
    const kpis = computeGameKPIs({ parsed }, resolvedSide, externalCounts);
    const newGame = {
      id: `g_${Date.now()}`, source, engineMode, engineNote, resolvedSide,
      addedAt: new Date().toISOString(), parsed, kpis,
    };
    const next = [...games, newGame];
    persist(next);
    setPgnInput("");
    setAddStatus({ ok: true, msg: "Partida adicionada e analisada." });
    setTab("dashboard");
  };

  const runAnalysisAndSave = async (pgnText, resolvedSide) => {
    const parsed = parsePGN(pgnText);

    if (engineMode === "lichess-cloud") {
      // Step 1 only: import and pause here. Saving happens later via completeLichessAnalysis.
      const r = await importToLichess(pgnText);
      if (r.ok) {
        setPendingLichessImport({ pgnText, resolvedSide, gameId: r.id, url: r.url });
        setAddStatus(null);
      } else {
        const msg = r.reason === "proxy_html_response"
          ? "O proxy dedicado (Cloudflare Worker) não respondeu corretamente agora — tente de novo em instantes."
          : "Não consegui importar a partida no Lichess agora (proxy ou rede). Tente de novo.";
        setAddStatus({ ok: false, msg });
      }
      return; // don't fall through to saveGameWithCounts — waiting on manual step
    }

    let engineNote = "Classificação baseada nas anotações (!!/!/?!/?/??) presentes no PGN.";
    let externalCounts = null;

    if (engineMode === "stockfish-js") {
      setAnalyzeProgress({ current: 0, total: parsed.moves.length });
      const r = await analyzeWithStockfish(pgnText, resolvedSide, (cur, tot) => setAnalyzeProgress({ current: cur, total: tot }));
      setAnalyzeProgress(null);
      if (r.ok) {
        externalCounts = r.counts;
        engineNote = "Analisado com Stockfish.js local, lance a lance, no seu navegador.";
      } else {
        engineNote = "Stockfish.js indisponível neste navegador agora — usando anotações do PGN como fallback.";
      }
    }

    saveGameWithCounts(pgnText, resolvedSide, externalCounts, engineNote);
  };

  // Step 2 of the Lichess flow, triggered by the "Buscar análise" button after the person
  // has manually clicked "Request a computer analysis" on the Lichess page and waited.
  const completeLichessAnalysis = async () => {
    if (!pendingLichessImport) return;
    const { pgnText, resolvedSide, gameId, url } = pendingLichessImport;
    setLichessFetchStatus({ loading: true });
    const r = await fetchLichessAnalysis(gameId, pgnText, resolvedSide);
    if (r.ok) {
      setPendingLichessImport(null);
      setLichessFetchStatus(null);
      saveGameWithCounts(pgnText, resolvedSide, r.counts, `Analisado pelo motor do Lichess. Partida: ${url}`);
    } else if (r.reason === "analysis_not_ready") {
      setLichessFetchStatus({ loading: false, msg: "A análise ainda não apareceu no Lichess. Confirme que clicou em \"Request a computer analysis\" na aba do Lichess e espere mais um pouco antes de tentar de novo." });
    } else {
      setLichessFetchStatus({ loading: false, msg: "Não consegui buscar a análise agora (proxy ou rede). Tente de novo em instantes." });
    }
  };

  const cancelLichessImport = () => {
    setPendingLichessImport(null);
    setLichessFetchStatus(null);
    setAnalyzing(false);
  };

  const handleAddGame = async () => {
    if (!pgnInput.trim()) { setAddStatus({ ok: false, msg: "Cole um PGN antes de adicionar." }); return; }
    setAnalyzing(true); setAddStatus(null);
    try {
      const parsed = parsePGN(pgnInput);
      if (parsed.moves.length === 0) {
        setAddStatus({ ok: false, msg: "Não consegui identificar lances nesse PGN. Verifique o formato." });
        setAnalyzing(false); return;
      }
      const side = detectUserSide(parsed.tags, settings.usernames);
      if (side === "unknown") {
        // Pause here and ask the user which color they played — resume via resolvePendingSide.
        setPendingSideChoice({ pgnText: pgnInput, tags: parsed.tags });
        setAnalyzing(false);
        return;
      }
      await runAnalysisAndSave(pgnInput, side);
    } catch (e) {
      setAddStatus({ ok: false, msg: "Erro ao processar o PGN: " + e.message });
    }
    setAnalyzing(false);
  };

  const resolvePendingSide = async (side) => {
    if (!pendingSideChoice) return;
    const { pgnText } = pendingSideChoice;
    setPendingSideChoice(null);
    setAnalyzing(true);
    try {
      await runAnalysisAndSave(pgnText, side);
    } catch (e) {
      setAddStatus({ ok: false, msg: "Erro ao processar o PGN: " + e.message });
    }
    setAnalyzing(false);
  };

  const handleDeleteGame = (id) => {
    const next = games.filter((g) => g.id !== id);
    persist(next);
    if (selectedGameId === id) setSelectedGameId(null);
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(games, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `painel-tatico-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (!Array.isArray(imported)) throw new Error("formato inválido");
        const existingIds = new Set(games.map((g) => g.id));
        const merged = [...games, ...imported.filter((g) => !existingIds.has(g.id))];
        persist(merged);
        setAddStatus({ ok: true, msg: `${imported.length} partida(s) importada(s).` });
      } catch (err) {
        setAddStatus({ ok: false, msg: "Arquivo de importação inválido." });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const agg = useMemo(() => aggregateKPIs(games), [games]);
  const last20 = useMemo(() => games.slice(-20), [games]);
  const agg20 = useMemo(() => aggregateKPIs(last20), [last20]);
  const tips = useMemo(() => generateTips(agg20 || agg, last20.length ? last20 : games), [agg20, agg, last20, games]);
  const selectedGame = games.find((g) => g.id === selectedGameId);

  return React.createElement("div", { style: { minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "-apple-system, sans-serif", paddingBottom: 60 } },
    React.createElement("div", { style: { borderBottom: `1px solid ${C.line}`, padding: "28px 20px 20px" } },
      React.createElement("div", { style: { maxWidth: 880, margin: "0 auto" } },
        React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" } },
          React.createElement("span", { style: { fontFamily: "Georgia, serif", fontSize: 26, letterSpacing: "-0.01em" } }, "Painel Tático"),
          React.createElement("span", { style: { color: C.brassDim, fontSize: 13 } }, "KPIs de xadrez, não estatística vazia")
        ),
        React.createElement("div", { style: { display: "flex", gap: 6, marginTop: 18, flexWrap: "wrap" } },
          [["dashboard", "Visão geral"], ["add", "Adicionar partida"], ["history", "Histórico"], ["settings", "Configurações"]].map(([key, label]) =>
            React.createElement("button", {
              key, onClick: () => setTab(key),
              style: { background: tab === key ? C.brass : "transparent", color: tab === key ? C.bg : C.inkDim, border: `1px solid ${tab === key ? C.brass : C.line}`, borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }
            }, label)
          ),
          React.createElement("button", { onClick: handleExport, style: { background: "transparent", color: C.inkDim, border: `1px solid ${C.line}`, borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer" } }, "Exportar backup"),
          React.createElement("label", { style: { background: "transparent", color: C.inkDim, border: `1px solid ${C.line}`, borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer" } },
            "Importar",
            React.createElement("input", { type: "file", accept: ".json", onChange: handleImport, style: { display: "none" } })
          )
        )
      )
    ),
    pendingSideChoice && React.createElement(SideChoiceModal, {
      tags: pendingSideChoice.tags,
      onChoose: resolvePendingSide,
      onCancel: () => setPendingSideChoice(null),
    }),
    pendingLichessImport && React.createElement(LichessPendingModal, {
      pending: pendingLichessImport,
      status: lichessFetchStatus,
      onFetch: completeLichessAnalysis,
      onCancel: cancelLichessImport,
    }),
    analyzeProgress && React.createElement("div", {
      style: { position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", background: C.bgPanel2, border: `1px solid ${C.brassDim}`, borderRadius: 8, padding: "10px 18px", fontSize: 13, color: C.brass, zIndex: 9998 }
    }, `Analisando com Stockfish… lance ${analyzeProgress.current}/${analyzeProgress.total}`),
    React.createElement("div", { style: { maxWidth: 880, margin: "0 auto", padding: "24px 20px" } },
      tab === "add" ? React.createElement(AddGameView, { pgnInput, setPgnInput, source, setSource, engineMode, setEngineMode, onAdd: handleAddGame, analyzing, status: addStatus })
      : tab === "settings" ? React.createElement(SettingsView, { settings, onSave: persistSettings })
      : tab === "history" ? React.createElement(HistoryView, { games, onSelect: (id) => { setSelectedGameId(id); setTab("game"); }, onDelete: handleDeleteGame })
      : tab === "game" && selectedGame ? React.createElement(GameDetailView, { game: selectedGame, onBack: () => setTab("history") })
      : React.createElement(DashboardView, { games, agg, agg20, last20, tips, onGoAdd: () => setTab("add"), onGoHistory: () => setTab("history"), onSelectGame: (id) => { setSelectedGameId(id); setTab("game"); } })
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
