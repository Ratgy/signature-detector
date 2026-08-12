import type {
  KeywordMatch,
  NormalizedRect,
  OCRToken,
  Rotation,
  ScoreBreakdown,
  SignatureCandidate,
} from './types'

const KEYWORDS = [
  { text: '매수인', weight: 42 },
  { text: '매수자', weight: 35 },
  { text: '연월일', weight: 34 },
  { text: '년월일', weight: 30 },
  { text: '서명', weight: 32 },
  { text: '성명', weight: 20 },
  { text: '(인)', weight: 24 },
  { text: '인', weight: 10 },
  { text: '날짜', weight: 14 },
]

const clean = (s: string) =>
  s.replace(/\s+/g, '').replace(/[.,:;_\-|]/g, '').replace(/[［\[]/g, '(').replace(/[］\]]/g, ')')

function levenshtein(a: string, b: string) {
  const aa = clean(a)
  const bb = clean(b)
  const dp = Array.from({ length: aa.length + 1 }, () => Array(bb.length + 1).fill(0))
  for (let i = 0; i <= aa.length; i++) dp[i][0] = i
  for (let j = 0; j <= bb.length; j++) dp[0][j] = j
  for (let i = 1; i <= aa.length; i++) {
    for (let j = 1; j <= bb.length; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[aa.length][bb.length]
}

function similarity(a: string, b: string) {
  const aa = clean(a)
  const bb = clean(b)
  if (!aa || !bb) return 0
  if (aa.includes(bb) || bb.includes(aa)) return Math.min(1, Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length) + 0.15)
  return 1 - levenshtein(aa, bb) / Math.max(aa.length, bb.length)
}

function center(r: NormalizedRect) {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

function distance(a: NormalizedRect, b: NormalizedRect) {
  const ca = center(a)
  const cb = center(b)
  return Math.hypot(ca.x - cb.x, ca.y - cb.y)
}

function union(rects: NormalizedRect[]): NormalizedRect {
  const x0 = Math.min(...rects.map(r => r.x))
  const y0 = Math.min(...rects.map(r => r.y))
  const x1 = Math.max(...rects.map(r => r.x + r.width))
  const y1 = Math.max(...rects.map(r => r.y + r.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function clampRect(r: NormalizedRect): NormalizedRect {
  const x = Math.max(0, Math.min(1, r.x))
  const y = Math.max(0, Math.min(1, r.y))
  const x1 = Math.max(x, Math.min(1, r.x + r.width))
  const y1 = Math.max(y, Math.min(1, r.y + r.height))
  return { x, y, width: x1 - x, height: y1 - y }
}

function expandForSignature(r: NormalizedRect): NormalizedRect {
  // Include context plus likely writing space to the right/below labels.
  const left = 0.05
  const top = 0.055
  const right = Math.max(0.25, r.width * 0.85)
  const bottom = Math.max(0.09, r.height * 1.2)
  return clampRect({
    x: r.x - left,
    y: r.y - top,
    width: r.width + left + right,
    height: r.height + top + bottom,
  })
}

function iou(a: NormalizedRect, b: NormalizedRect) {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.width, b.x + b.width)
  const y1 = Math.min(a.y + a.height, b.y + b.height)
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  const ua = a.width * a.height + b.width * b.height - inter
  return ua ? inter / ua : 0
}

export function unrotateRect(r: NormalizedRect, rotation: Rotation): NormalizedRect {
  if (rotation === 0) return r
  const pts = [
    [r.x, r.y],
    [r.x + r.width, r.y],
    [r.x, r.y + r.height],
    [r.x + r.width, r.y + r.height],
  ].map(([x, y]) => {
    if (rotation === 90) return [y, 1 - x]
    if (rotation === 180) return [1 - x, 1 - y]
    return [1 - y, x] // 270
  })
  const xs = pts.map(p => p[0])
  const ys = pts.map(p => p[1])
  return clampRect({
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  })
}

function buildNgrams(tokens: OCRToken[]) {
  const out = [...tokens]
  const sorted = [...tokens].sort((a, b) => center(a.rect).y - center(b.rect).y || a.rect.x - b.rect.x)
  for (let i = 0; i < sorted.length; i++) {
    for (let len = 2; len <= 4 && i + len <= sorted.length; len++) {
      const group = sorted.slice(i, i + len)
      const ys = group.map(t => center(t.rect).y)
      if (Math.max(...ys) - Math.min(...ys) > 0.018) break
      const gaps = group.slice(1).map((t, idx) => t.rect.x - (group[idx].rect.x + group[idx].rect.width))
      if (gaps.some(g => g > 0.035)) break
      out.push({
        text: group.map(t => t.text).join(''),
        confidence: Math.min(...group.map(t => t.confidence)),
        rect: union(group.map(t => t.rect)),
        pageIndex: group[0].pageIndex,
      })
    }
  }
  return out
}

function keywordMatches(tokens: OCRToken[]): KeywordMatch[] {
  const grams = buildNgrams(tokens)
  const matches: KeywordMatch[] = []
  for (const token of grams) {
    for (const kw of KEYWORDS) {
      const sim = similarity(token.text, kw.text)
      const threshold = kw.text.length <= 1 ? 0.99 : kw.text.length <= 2 ? 0.82 : 0.68
      if (sim >= threshold) {
        matches.push({ ...token, keyword: kw.text, similarity: sim, weight: kw.weight })
      }
    }
  }
  // Remove near-identical duplicate matches produced by n-grams.
  return matches.filter((m, idx) =>
    !matches.slice(0, idx).some(prev =>
      prev.keyword === m.keyword && iou(prev.rect, m.rect) > 0.78 && prev.similarity >= m.similarity
    )
  )
}

function scoreCluster(cluster: KeywordMatch[], rect: NormalizedRect): { total: number, confidence: number, breakdown: ScoreBreakdown } {
  const unique = new Map<string, KeywordMatch>()
  for (const m of cluster) {
    const old = unique.get(m.keyword)
    if (!old || m.similarity * m.confidence > old.similarity * old.confidence) unique.set(m.keyword, m)
  }
  const vals = [...unique.values()]
  const keyword = vals.reduce((s, m) => s + m.weight * m.similarity, 0)

  let proximity = 0
  const pairs = [['매수인', '연월일'], ['매수인', '(인)'], ['매수인', '서명'], ['매수자', '서명']]
  for (const [a, b] of pairs) {
    const ma = vals.find(v => v.keyword === a)
    const mb = vals.find(v => v.keyword === b)
    if (ma && mb) {
      const d = distance(ma.rect, mb.rect)
      proximity += Math.max(0, 22 * (1 - d / 0.24))
    }
  }

  let layout = 0
  for (let i = 0; i < vals.length; i++) {
    for (let j = i + 1; j < vals.length; j++) {
      const ay = center(vals[i].rect).y
      const by = center(vals[j].rect).y
      if (Math.abs(ay - by) < 0.035) layout += 4
    }
  }
  layout = Math.min(layout, 20)

  const cy = center(rect).y
  let position = 0
  if (cy > 0.5) position += 8
  if (cy > 0.7) position += 8
  if (cy > 0.82) position += 4

  const avgOcr = vals.length ? vals.reduce((s, m) => s + m.confidence, 0) / vals.length : 0
  const ocr = Math.max(-12, Math.min(12, (avgOcr - 55) * 0.3))
  const total = keyword + proximity + layout + position + ocr

  // Confidence is deliberately conservative: score + OCR quality + number of distinct anchors.
  const anchorFactor = Math.min(1, vals.length / 3)
  const confidence = Math.max(0, Math.min(0.99, (total / 150) * 0.72 + (avgOcr / 100) * 0.18 + anchorFactor * 0.10))
  return { total, confidence, breakdown: { keyword, proximity, layout, position, ocr } }
}

export function detectSignatureCandidates(
  rawTokens: OCRToken[],
  rotation: Rotation,
): SignatureCandidate[] {
  const matches = keywordMatches(rawTokens)
  if (!matches.length) return []

  const candidates: SignatureCandidate[] = []
  for (const seed of matches) {
    const c0 = center(seed.rect)
    const cluster = matches.filter(m => {
      const c = center(m.rect)
      return Math.abs(c.x - c0.x) < 0.55 && Math.abs(c.y - c0.y) < 0.18
    })
    const core = union(cluster.map(m => m.rect))
    const rotatedRect = expandForSignature(core)
    const scored = scoreCluster(cluster, rotatedRect)
    candidates.push({
      id: `${seed.pageIndex}-${rotation}-${candidates.length}`,
      pageIndex: seed.pageIndex,
      rect: unrotateRect(rotatedRect, rotation),
      rotatedRect,
      rotation,
      score: scored.total,
      confidence: scored.confidence,
      matchedKeywords: [...new Set(cluster.map(m => m.keyword))],
      breakdown: scored.breakdown,
    })
  }

  const sorted = candidates.sort((a, b) => b.score - a.score)
  const deduped: SignatureCandidate[] = []
  for (const c of sorted) {
    if (!deduped.some(d => d.pageIndex === c.pageIndex && iou(d.rect, c.rect) > 0.55)) deduped.push(c)
  }
  return deduped.slice(0, 3)
}
