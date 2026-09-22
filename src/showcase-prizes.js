import { randomInt } from 'node:crypto'

// Showcase frequency is independent from the weight used to award a real prize.
export function sampleShowcasePrizes(prizes, count = 5, random = () => randomInt(0, 1_000_000) / 1_000_000) {
  const remaining = prizes.map(prize => ({ prize, weight: Number(prize.showcaseWeight ?? 1) }))
    .filter(item => Number.isFinite(item.weight) && item.weight > 0)
  const selected = []
  const limit = Math.min(Math.max(0, Math.floor(count)), remaining.length)
  while (selected.length < limit) {
    const total = remaining.reduce((sum, item) => sum + item.weight, 0)
    let target = random() * total
    let index = remaining.length - 1
    for (let candidate = 0; candidate < remaining.length; candidate++) {
      target -= remaining[candidate].weight
      if (target < 0) { index = candidate; break }
    }
    selected.push(remaining.splice(index, 1)[0].prize)
  }
  return selected
}
